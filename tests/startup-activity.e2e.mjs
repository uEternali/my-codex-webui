import { createServer } from 'node:net';
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';
import { artifact, launchOptions, root } from './browser-runtime.mjs';

const assert = (value, message) => { if (!value) throw new Error(message); };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const temporary = await mkdtemp(join(tmpdir(), 'webui-startup-activity-'));
const bin = join(temporary, 'bin'), home = join(temporary, 'codex'), log = join(temporary, 'responses.jsonl');
await mkdir(bin); await mkdir(home); await writeFile(log, '');
await copyFile(join(root, 'tests/fixtures/approval-codex.mjs'), join(bin, 'codex'));
await chmod(join(bin, 'codex'), 0o700);
const port = await new Promise((resolve, reject) => {
  const probe = createServer(); probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => { const port = probe.address().port; probe.close(error => error ? reject(error) : resolve(port)); });
});
const base = `http://127.0.0.1:${port}`;
const server = Bun.spawn([process.execPath, 'run', 'server.ts'], {
  cwd: root,
  env: { ...process.env, PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH}`, HOST: '127.0.0.1', PORT: String(port), CODEX_HOME: home, CODEX_WEBUI_CWD: temporary, CODEX_WEBUI_AUTH_STORE: join(temporary, 'auth.json'), CODEX_WEBUI_PASSWORD: '', CODEX_WEBUI_ACCESS_TOKEN: '', APPROVAL_FIXTURE_LOG: log },
  stdout: 'ignore', stderr: 'inherit',
});
let browser;
try {
  const deadline = Date.now() + 15_000;
  while (true) {
    try { if ((await fetch(`${base}/api/health`).then(response => response.json())).codex) break; } catch {}
    if (Date.now() > deadline) throw new Error('Fixture server did not start');
    await Bun.sleep(50);
  }
  browser = await chromium.launch(launchOptions());
  const context = await browser.newContext({ viewport: { width: 1280, height: 850 }, colorScheme: 'light' });
  await context.addInitScript(() => { if (window === window.top) localStorage.setItem('codex-webui-locale', 'en'); });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const bundle = deferred(), bundleReached = deferred(), config = deferred(), configReached = deferred(), connected = deferred(), models = deferred(), modelsReached = deferred(), account = deferred(), accountReached = deferred();
  let history = null, historyReached = null, modelHold = models, modelReached = modelsReached, failNextModels = false, bridgeSocket;
  await page.route('**/app.bundle.js', async route => { bundleReached.resolve(); await bundle.promise; await route.continue(); });
  await page.route('**/api/account', async route => { accountReached.resolve(); await account.promise; await route.continue(); });
  await page.route('**/api/config', async route => { configReached.resolve(); await config.promise; await route.continue(); });
  await page.routeWebSocket('**/ws', socket => {
    bridgeSocket = socket;
    const upstream = socket.connectToServer(), methods = new Map();
    socket.onMessage(raw => { const request = JSON.parse(raw); methods.set(request.id, request.method); upstream.send(raw); });
    upstream.onMessage(async raw => {
      const message = JSON.parse(raw);
      if (message.type === 'bridge/status' && message.status === 'connected') await connected.promise;
      if (message.type === 'rpc/result' && methods.get(message.id) === 'model/list') {
        modelReached?.resolve(); if (modelHold) await modelHold.promise;
        if (failNextModels) { failNextModels = false; socket.send(JSON.stringify({ type: 'rpc/error', id: message.id, error: 'Fixture model list unavailable' })); return; }
      }
      if (message.type === 'rpc/result' && methods.get(message.id) === 'thread/read' && history) { historyReached.resolve(); await history.promise; }
      socket.send(raw);
    });
  });
  const assertConnecting = async (stage, target = page) => {
    const state = await target.locator('#startupScreen').evaluate(node => {
      const mark = node.querySelector('.empty-codex-mark'), icon = mark?.getBoundingClientRect();
      return { text: node.innerText.trim(), headings: [...node.querySelectorAll('h1,p')].filter(child => child.getClientRects().length).length, busy: node.getAttribute('aria-busy'), icon: icon && { width: icon.width, height: icon.height }, margin: mark && getComputedStyle(mark).marginBottom, present: !!mark?.querySelector('svg') || getComputedStyle(mark).maskImage !== 'none' };
    });
    assert(state.text === '' && state.headings === 0 && state.busy === 'true' && state.icon?.width === 48 && state.icon?.height === 48 && state.margin === '0px' && state.present, `${stage} must show only the centered Codex icon: ${JSON.stringify(state)}`);
    const gate = await target.locator('#app').evaluate(app => {
      document.querySelector('#prompt').focus();
      return { loading: app.hasAttribute('data-loading'), hidden: app.getAttribute('aria-hidden'), inert: app.inert, busy: app.getAttribute('aria-busy'), focused: document.activeElement?.id, chrome: [...app.querySelectorAll('.topbar,.sidebar,.composer-dock')].map(node => getComputedStyle(node).visibility) };
    });
    assert(gate.loading && gate.hidden === 'true' && gate.inert && gate.busy === 'true' && gate.focused !== 'prompt' && gate.chrome.every(visibility => visibility === 'hidden'), `${stage} must hide and disable all app controls: ${JSON.stringify(gate)}`);
    assert(await target.locator('#startupScreen').isVisible(), `${stage} must keep the startup screen visible`);
  };
  const assertReady = async target => {
    await target.waitForFunction(() => !globalThis.__codexWebuiDebug?.state.initializing && !document.querySelector('#app').hasAttribute('data-loading'));
    const gate = await target.locator('#app').evaluate(app => ({ inert: app.inert, hidden: app.getAttribute('aria-hidden'), busy: app.getAttribute('aria-busy') }));
    assert(!gate.inert && gate.hidden === null && gate.busy === null && !(await target.locator('#startupScreen').isVisible()), `Ready app must be interactive: ${JSON.stringify(gate)}`);
    assert(await target.locator('#modelButton').isVisible() && await target.locator('#prompt').isVisible(), 'Composer must appear when ready');
  };
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await bundleReached.promise; await assertConnecting('Before the bundle loads');
  bundle.resolve(); await configReached.promise; await assertConnecting('Before configuration loads');
  config.resolve(); await page.waitForFunction(() => globalThis.__codexWebuiDebug?.state.ws);
  await assertConnecting('Before Codex connects');
  connected.resolve(); await modelsReached.promise; await assertConnecting('Before initial data loads');
  await page.screenshot({ path: artifact('startup-icon-only.png') });
  models.resolve(); await accountReached.promise; await assertConnecting('Before account data loads');
  account.resolve(); await page.locator('#emptyState h1').waitFor(); await assertReady(page);
  modelHold = null; modelReached = null;
  assert((await page.locator('#emptyState h1').textContent()).includes('What can I help'), 'The connected new-task welcome must remain available');

  // The protocol fixture ends the turn without completing its pending command.
  await page.locator('#composerProjectButton').click(); await page.locator('#projectlessOption').click();
  await page.locator('#prompt').fill('commandExecution interruption regression');
  await page.locator('#prompt').press('Enter');
  await page.locator('.approval-card').waitFor();
  await page.locator('#sendButton').click();
  await page.locator('.approval-card').waitFor({ state: 'detached' });
  await page.waitForFunction(() => document.querySelector('[data-turn-live-status]')?.textContent === 'Stopped');
  const assertSettled = async stage => {
    const state = await page.locator('#conversation').evaluate(root => ({ animated: root.querySelectorAll('.activity-item.active,.activity-group.active,.activity-name.loading-shimmer,.activity-summary-copy.loading-shimmer').length, command: root.querySelector('.command-activity .activity-name')?.textContent, footer: root.querySelector('.command-shell-footer')?.textContent }));
    assert(state.animated === 0 && state.command?.startsWith('Stopped') && state.footer === 'Stopped', `${stage} must stop every pending tool: ${JSON.stringify(state)}`);
  };
  await assertSettled('Live interruption');
  history = deferred(); historyReached = deferred();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await historyReached.promise; await assertConnecting('While restoring the remembered conversation');
  history.resolve();
  await page.waitForFunction(() => document.querySelector('[data-turn-live-status]')?.textContent === 'Stopped');
  await assertSettled('Reloaded interrupted history'); await assertReady(page);
  await page.screenshot({ path: artifact('command-stopped-after-reload.png') });
  history = null;

  const terminalResults = await page.evaluate(() => {
    const api = globalThis.__codexWebuiDebug, results = [];
    for (const status of ['interrupted', 'cancelled', 'canceled', 'failed', 'completed']) {
      api.startNewTask(); api.state.active = { id: 'terminal-thread', cwd: '/tmp', turns: [] };
      api.notify('turn/started', { threadId: 'terminal-thread', turn: { id: 'terminal-turn' } });
      for (const [id, type] of [['pending', 'commandExecution'], ['thinking', 'reasoning'], ['editing', 'fileChange']]) api.notify('item/started', { threadId: 'terminal-thread', turnId: 'terminal-turn', item: { id, type, command: 'curl example.test', summary: ['Partial reasoning'], changes: [], aggregatedOutput: 'partial output' } });
      api.notify('item/completed', { threadId: 'terminal-thread', turnId: 'terminal-turn', item: { id: 'done', type: 'commandExecution', command: 'curl example.test', status: 'failed', exitCode: 6, aggregatedOutput: 'Could not resolve host' } });
      api.notify('turn/completed', { threadId: 'terminal-thread', turn: { id: 'terminal-turn', status } });
      // Late snapshots, starts, and terminal input must not resurrect a stopped tool.
      api.syncTurnSnapshot({ id: 'terminal-turn', status: 'inProgress', items: [{ id: 'pending', type: 'commandExecution', status: 'inProgress', command: 'curl example.test', aggregatedOutput: 'partial output' }] });
      api.notify('item/started', { threadId: 'terminal-thread', turnId: 'terminal-turn', item: { id: 'late', type: 'commandExecution', command: 'echo late' } });
      api.notify('item/commandExecution/terminalInteraction', { threadId: 'terminal-thread', turnId: 'terminal-turn', itemId: 'pending', stdin: 'echo late\r' });
      const timeline = document.querySelector('[data-turn-id="terminal-turn"]'), items = api.state.activityItems.get('terminal-turn');
      results.push({ status, animated: timeline.querySelectorAll('.activity-item.active,.activity-group.active,.activity-name.loading-shimmer,.activity-summary-copy.loading-shimmer').length, busy: timeline.getAttribute('aria-busy'), output: items.get('pending').aggregatedOutput, failed: items.get('done'), stopButton: document.querySelector('#sendButton').dataset.submitMode });
    }
    return results;
  });
  for (const result of terminalResults) assert(result.animated === 0 && result.busy === 'false' && result.output === 'partial output' && result.failed.status === 'failed' && result.failed.exitCode === 6 && result.failed.aggregatedOutput === 'Could not resolve host' && result.stopButton === 'send', `Terminal state regressed: ${JSON.stringify(result)}`);
  // A reconnect must preserve the already-visible UI and an unsent draft.
  await page.locator('#prompt').fill('Keep this draft');
  modelHold = deferred(); modelReached = deferred();
  bridgeSocket.send(JSON.stringify({ type: 'bridge/status', status: 'disconnected' }));
  bridgeSocket.send(JSON.stringify({ type: 'bridge/status', status: 'connected' }));
  await modelReached.promise; await assertReady(page);
  assert(await page.locator('#prompt').inputValue() === 'Keep this draft', 'Reconnect must retain the composer draft');
  modelHold.resolve();
  await page.waitForFunction(() => globalThis.__codexWebuiDebug.state.pending.size === 0);
  modelHold = null; modelReached = null;

  // Failed startup data stays behind the gate and can retry without a page reload.
  failNextModels = true;
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#startupError:not([hidden])').waitFor();
  assert((await page.locator('#startupErrorDetail').textContent()).includes('Fixture model list unavailable'), 'Initialization error must be visible');
  assert(await page.locator('#startupRetry').isVisible() && !(await page.locator('#prompt').isVisible()), 'Failed startup must expose retry, not half-loaded controls');
  await page.locator('#startupRetry').click(); await assertReady(page);

  // The same gate must work across password login on a touch-sized screen.
  const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await phoneContext.addInitScript(() => { if (window === window.top) localStorage.setItem('codex-webui-locale', 'en'); });
  const phone = await phoneContext.newPage(), phoneBundle = deferred(), phoneBundleReached = deferred();
  phone.on('pageerror', error => errors.push(error.message));
  await phone.clock.install();
  await phone.route('**/api/auth/status', route => route.fulfill({ json: { authenticated: false, passwordRequired: true, setupRequired: false } }));
  await phone.route('**/api/auth/login', route => route.fulfill({ json: { ok: true } }));
  await phone.route('**/app.bundle.js', async route => { phoneBundleReached.resolve(); await phoneBundle.promise; await route.continue(); });
  await phone.goto(base, { waitUntil: 'domcontentloaded' });
  await phone.locator('#passwordGate:not([hidden])').waitFor();
  assert(!(await phone.locator('#startupScreen').isVisible()) && !(await phone.locator('#prompt').isVisible()), 'Password gate must own the screen before login');
  await phone.locator('#passwordInput').fill('fixture password'); await phone.locator('#passwordLoginButton').click();
  await phoneBundleReached.promise; await assertConnecting('After mobile password login', phone);
  await phone.clock.fastForward(20_001);
  await phone.locator('#startupError:not([hidden])').waitFor();
  assert((await phone.locator('#startupErrorDetail').textContent()).includes('taking longer'), 'Slow startup must offer recovery');
  phoneBundle.resolve(); await assertReady(phone);

  // An unavailable bundle must show a retry instead of leaving a blank screen.
  await phone.unroute('**/app.bundle.js');
  let abortBundle = true;
  await phone.route('**/app.bundle.js', route => { if (abortBundle) { abortBundle = false; return route.abort(); } return route.continue(); });
  await phone.reload({ waitUntil: 'domcontentloaded' });
  await phone.locator('#passwordInput').fill('fixture password'); await phone.locator('#passwordLoginButton').click();
  await phone.locator('#startupError:not([hidden])').waitFor();
  assert(!(await phone.locator('#prompt').isVisible()), 'Bundle failure must not expose uninitialized controls');
  await phone.locator('#startupRetry').click();
  await phone.locator('#passwordInput').fill('fixture password'); await phone.locator('#passwordLoginButton').click();
  await assertReady(phone);
  await phoneContext.close();
  assert(errors.length === 0, `Browser errors: ${errors.join('; ')}`);
  console.log(JSON.stringify({ startupStages: ['static', 'configuration', 'connection', 'initial data', 'account', 'remembered history'], coordinatedReveal: true, reconnectPreservesDraft: true, failedStartupRetry: true, slowStartupRecovery: true, failedBundleRetry: true, mobilePasswordGate: true, liveInterruption: true, reloadedInterruption: true, terminalStates: terminalResults.map(({ status }) => status), lateEventsStaySettled: true, browserErrors: errors }, null, 2));
} finally {
  await browser?.close(); server.kill(); await server.exited;
  await rm(temporary, { recursive: true, force: true });
}
