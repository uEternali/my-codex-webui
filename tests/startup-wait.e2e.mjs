import { createServer } from 'node:net';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { chromium, webkit } from 'playwright';
import { artifact, launchOptions, root } from './browser-runtime.mjs';

const assert = (value, message) => { if (!value) throw Error(message); };
const temporary = mkdtempSync(join(tmpdir(), 'webui-startup-wait-'));
for (const name of ['bin', 'codex', 'workspace']) mkdirSync(join(temporary, name));
const cwd = join(temporary, 'workspace'), control = join(temporary, 'control.json'), log = join(temporary, 'rpc.jsonl');
const output = 'sample output\n'.repeat(100000);
writeFileSync(control, JSON.stringify({ projects: [{ prefix: 'startup', cwd, count: 1, threads: [{ turns: [{ id: 'bulk-turn', status: 'completed', items: [{ id: 'bulk', type: 'commandExecution', command: 'echo sample', status: 'completed', aggregatedOutput: output, exitCode: 0 }] }] }] }] }));
copyFileSync(join(root, 'tests/fixtures/thread-actions-codex.mjs'), join(temporary, 'bin/codex'));
chmodSync(join(temporary, 'bin/codex'), 0o700);
const port = await new Promise(resolve => { const probe = createServer(); probe.listen(0, '127.0.0.1', () => { const value = probe.address().port; probe.close(() => resolve(value)); }); });
const base = `http://127.0.0.1:${port}`;
const server = Bun.spawn([process.execPath, 'run', process.env.WEBUI_TEST_SERVER_ENTRY || 'server.ts'], { cwd: root, env: { ...process.env,
  PATH: `${join(temporary, 'bin')}:${dirname(process.execPath)}:${process.env.PATH}`, HOST: '127.0.0.1', PORT: String(port),
  CODEX_HOME: join(temporary, 'codex'), CODEX_WEBUI_CWD: cwd, CODEX_WEBUI_AUTH_STORE: join(temporary, 'auth.json'), CODEX_WEBUI_PASSWORD: '', CODEX_WEBUI_ACCESS_TOKEN: '', ACTION_FIXTURE_CONTROL: control, ACTION_FIXTURE_LOG: log,
}, stdout: 'ignore', stderr: 'inherit' });
const ready = page => page.waitForFunction(() => globalThis.__codexWebuiDebug?.state.connected && !globalThis.__codexWebuiDebug.state.initializing);
let browser, releaseBundle; const errors = [];
try {
  const deadline = Date.now() + 10000;
  while (true) { try { if ((await fetch(base + '/api/health').then(r => r.json())).codex) break; } catch {} if (Date.now() > deadline) throw Error('Fixture did not start'); await Bun.sleep(30); }
  browser = process.env.PLAYWRIGHT_BROWSER === 'webkit' ? await webkit.launch({ headless: true }) : await chromium.launch(launchOptions());
  const context = await browser.newContext({ viewport: { width: 1018, height: 820 } });
  await context.addInitScript(() => {
    if (window !== window.top) return;
    localStorage.setItem('codex-webui-locale', 'en');
    const original = window.setTimeout;
    window.setTimeout = (callback, delay, ...args) => original(callback, delay === 20000 ? 80 : delay, ...args);
  });
  const page = await context.newPage(); page.setDefaultTimeout(8000); page.on('pageerror', error => errors.push(error.message));
  const bundle = new Promise(resolve => { releaseBundle = resolve; });
  await page.route('**/app.bundle.js', async route => { await bundle; await route.continue(); }, { times: 1 });
  let navigations = 0; page.on('request', request => { if (request.isNavigationRequest() && request.frame() === page.mainFrame()) navigations++; });
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.getByText('Still connecting to Codex', { exact: true }).waitFor();
  assert(await page.locator('#startupScreen').getAttribute('aria-busy') === 'true', 'A delayed download stays in progress');
  assert(await page.locator('#startupError').getAttribute('role') === 'status', 'Slow loading is a status, not a failure alert');
  assert(await page.locator('#startupRetry').isVisible(), 'A slow connection can still be retried manually');
  await page.screenshot({ path: artifact('startup-slow-connection.png') });
  releaseBundle(); await ready(page);
  const afterLoad = { hidden: await page.locator('#startupScreen').isHidden(), navigations, loading: await page.locator('#app').getAttribute('data-loading') };
  assert(afterLoad.hidden && afterLoad.loading === null && navigations === 1, `The delayed download completes automatically without a reload: ${JSON.stringify(afterLoad)}`);
  await context.close();

  const failureContext = await browser.newContext();
  await failureContext.addInitScript(() => { if (window === window.top) localStorage.setItem('codex-webui-locale', 'en'); });
  const failure = await failureContext.newPage(); failure.setDefaultTimeout(8000); failure.on('pageerror', error => errors.push(error.message));
  await failure.route('**/api/auth/status', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Service unavailable' }) }), { times: 1 });
  await failure.goto(base, { waitUntil: 'domcontentloaded' });
  await failure.getByText('Unable to load Codex', { exact: true }).waitFor();
  assert(await failure.locator('#startupScreen').getAttribute('aria-busy') === 'false' && await failure.locator('#startupError').getAttribute('role') === 'alert', 'Actual request failures remain visible');
  await failure.locator('#startupRetry').click(); await ready(failure);
  await failureContext.close();

  const historyContext = await browser.newContext();
  const history = await historyContext.newPage();
  history.on('pageerror', error => errors.push(error.message));
  const historyReply = history.waitForResponse(response => response.url().endsWith('/api/rpc') && response.request().postDataJSON()?.method === 'thread/read');
  await history.goto(base + '/?thread=startup-0');
  const reply = await historyReply;
  const replyBody = await reply.json();
  assert(reply.headers()['content-encoding'] === 'gzip' && replyBody.result.thread.turns[0].items[0].aggregatedOutput === output, 'The browser reads full history over compressed HTTP');
  await history.waitForFunction(() => globalThis.__codexWebuiDebug?.state.connected && !globalThis.__codexWebuiDebug.state.threadLoading);
  assert(await history.evaluate(() => globalThis.__codexWebuiDebug.state.transport === 'ws' && globalThis.__codexWebuiDebug.state.ws.readyState === 1), 'Real-time events retain their WebSocket connection');
  await historyContext.close();

  const rpcBody = JSON.stringify({ id: 10, method: 'thread/read', params: { threadId: 'startup-0', includeTurns: true } });
  const httpResults = [];
  for (const encoding of ['gzip', 'gzip;q=0']) {
    const response = await fetch(base + '/api/rpc', { method: 'POST', headers: { 'content-type': 'application/json', origin: base, 'accept-encoding': encoding }, body: rpcBody });
    const text = await response.text(), value = JSON.parse(text);
    assert(value.result.thread.turns[0].items[0].aggregatedOutput === output, 'HTTP compression preserves the complete conversation');
    const bytes = Number(response.headers.get('content-length'));
    assert(response.headers.get('cache-control') === 'no-store', 'Private conversation replies are not cached');
    assert(encoding === 'gzip' ? response.headers.get('content-encoding') === 'gzip' && bytes < text.length / 10 : !response.headers.get('content-encoding') && bytes === text.length, 'HTTP fallback supports compression and explicit opt-out');
    httpResults.push({ encoding, wireBytes: bytes, decodedBytes: text.length });
  }
  const calls = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  assert(!calls.some(call => ['turn/start', 'turn/interrupt', 'thread/delete'].includes(call.method)), 'Loading and retrying do not modify chat tasks');
  assert(!errors.length, errors.join('; '));
  console.log(JSON.stringify({ ok: true, slowDownloadContinues: true, noReload: true, realErrorRetry: true, compressedHistory: true, realtimeWebSocket: true, httpResults, errors }));
} finally { releaseBundle?.(); await browser?.close(); server.kill(); await server.exited; rmSync(temporary, { recursive: true, force: true }); }
