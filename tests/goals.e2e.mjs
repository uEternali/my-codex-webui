import { createServer } from 'node:net';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';
import { artifact, launchOptions, root } from './browser-runtime.mjs';

const assert = (value, message) => { if (!value) throw new Error(message); };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const composerGeometry = page => page.evaluate(() => Object.fromEntries(['composer', 'prompt', 'sendButton', 'goalPicker'].map(id => {
  const { x, y, width, height, bottom } = document.getElementById(id).getBoundingClientRect();
  return [id, { x, y, width, height, bottom }];
})));
const assertGoalLayout = async (page, baseline) => {
  const current = await composerGeometry(page);
  for (const id of ['prompt', 'sendButton']) for (const key of ['x', 'y', 'width', 'height']) {
    assert(Math.abs(current[id][key] - baseline[id][key]) < 1, `Adding a goal must preserve ${id} ${key}`);
  }
  assert(Math.abs(current.composer.bottom - baseline.composer.bottom) < 1, 'The shared composer must stay anchored at the bottom');
  assert(current.composer.y < baseline.composer.y && current.composer.height > baseline.composer.height, 'The shared rounded frame must expand upward');
  assert(current.goalPicker.y >= current.composer.y && current.goalPicker.bottom <= current.prompt.y, 'Goal controls must be above the input, inside the shared composer');
  assert(await page.locator('#composer > #goalPicker').count() === 1, 'The goal row must share the input frame');
};
const assertGoalEllipsis = async page => {
  const preview = await page.locator('#goalObjectivePreview').evaluate(node => {
    const style = getComputedStyle(node);
    return { overflow: style.overflow, textOverflow: style.textOverflow, whiteSpace: style.whiteSpace, clipped: node.scrollWidth > node.clientWidth, height: node.getBoundingClientRect().height, lineHeight: parseFloat(style.lineHeight) };
  });
  assert(preview.clipped && preview.textOverflow === 'ellipsis' && preview.overflow === 'hidden' && preview.whiteSpace === 'nowrap', 'Long goal descriptions must be truncated with an ellipsis');
  assert(preview.height <= preview.lineHeight + 1, 'The goal preview must remain one line');
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'A long goal must not overflow the page');
};
const temporary = await mkdtemp(join(tmpdir(), 'webui-goals-'));
const bin = join(temporary, 'bin'), home = join(temporary, 'codex'), log = join(temporary, 'rpc.jsonl');
await mkdir(bin); await mkdir(home); await writeFile(log, '');
await copyFile(join(root, 'tests/fixtures/goal-codex.mjs'), join(bin, 'codex')); await chmod(join(bin, 'codex'), 0o700);
const port = await new Promise((resolve, reject) => {
  const probe = createServer(); probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => { const value = probe.address().port; probe.close(error => error ? reject(error) : resolve(value)); });
});
const base = `http://127.0.0.1:${port}`;
const server = Bun.spawn([process.execPath, 'run', 'server.ts'], {
  cwd: root,
  env: { ...process.env, PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH}`, HOST: '127.0.0.1', PORT: String(port), CODEX_HOME: home, CODEX_WEBUI_CWD: homedir(), CODEX_WEBUI_AUTH_STORE: join(temporary, 'auth.json'), CODEX_WEBUI_PASSWORD: '', CODEX_WEBUI_ACCESS_TOKEN: '', GOAL_FIXTURE_LOG: log },
  stdout: 'ignore', stderr: 'inherit',
});
let browser, rpcId = 1;
const rpc = async (method, params = {}) => {
  const response = await fetch(`${base}/api/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ id: rpcId++, method, params }) });
  const result = await response.json();
  if (result.type !== 'rpc/result') throw new Error(result.error || JSON.stringify(result));
  return result.result;
};
const protocolLog = async () => (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
const errors = [];
try {
  const deadline = Date.now() + 15_000;
  while (true) {
    try { if ((await fetch(`${base}/api/health`).then(response => response.json())).codex) break; } catch {}
    if (Date.now() > deadline) throw new Error('Goal fixture server did not start');
    await Bun.sleep(50);
  }
  browser = await chromium.launch(launchOptions());
  for (const transport of ['ws', 'sse']) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 850 }, colorScheme: 'light' });
    await context.addInitScript(() => { if(window === window.top) localStorage.setItem('codex-webui-locale', 'en'); });
    const page = await context.newPage(); page.on('pageerror', failure => errors.push(failure.message));
    let getGate = null;
    if (transport === 'sse') await page.routeWebSocket('**/ws', socket => socket.close());
    else await page.routeWebSocket('**/ws', socket => {
      const upstream = socket.connectToServer(), methods = new Map();
      socket.onMessage(raw => { const message = JSON.parse(raw); methods.set(message.id, message.method); upstream.send(raw); });
      upstream.onMessage(async raw => {
        const message = JSON.parse(raw);
        if (message.type === 'rpc/result' && methods.get(message.id) === 'thread/goal/get' && getGate) {
          const gate = getGate; getGate = null; gate.reached.resolve(); await gate.release.promise;
        }
        socket.send(raw);
      });
    });
    await page.goto(base); await page.locator('#emptyState h1').waitFor();
    await page.locator('#composerProjectButton').click(); await page.locator('#projectlessOption').click();
    assert(!await page.locator('#goalPicker').isVisible(), 'New chats must not inherit another goal');
    const desktopBaseline = await composerGeometry(page);
    // Autocomplete must offer a real goal editor, rather than sending slash text.
    await page.locator('#prompt').fill('/go');
    await page.locator('[data-autocomplete-id="goal"]').click();
    await page.locator('#goalDialog[open]').waitFor();
    assert(await page.locator('#goalObjective').inputValue() === '', 'The new goal editor starts empty');
    await page.locator('#goalCancel').click();
    assert(await page.locator('#prompt').inputValue() === '', 'Cancelling the slash editor must restore the empty composer placeholder');
    await page.locator('#prompt').fill(`/goal Ship ${transport} feature and verify its tests`);
    await page.locator('#prompt').press('Enter');
    await page.waitForFunction(() => document.querySelector('#goalStatusLabel').textContent === 'Pursuing goal');
    const first = (await rpc('thread/list')).data.at(-1), firstId = first.id;
    assert((await rpc('thread/goal/get', { threadId: firstId })).goal.objective === `Ship ${transport} feature and verify its tests`, 'Objective must be persisted in Codex');
    const requestLog = await protocolLog();
    assert(!requestLog.some(value => value.method === 'turn/start' && value.params.threadId === firstId), 'Goal creation must rely on native continuation, without a second turn/start');
    assert(requestLog.some(value => value.method === 'thread/goal/set' && value.params.origin === 'user'), 'Goal mutation must include explicit user provenance');
    assert(await page.locator('#prompt').inputValue() === '', 'Accepted goal commands must clear the composer');
    await assertGoalLayout(page, desktopBaseline);
    const longObjective = 'Verify goal layout and retain input position. '.repeat(30);
    await rpc('thread/goal/set', { threadId: firstId, objective: longObjective, origin: 'user' });
    await page.waitForFunction(text => document.querySelector('#goalObjectivePreview').textContent === text, longObjective);
    await assertGoalLayout(page, desktopBaseline); await assertGoalEllipsis(page);
    await page.screenshot({ path: artifact(`goal-layout-desktop-${transport}.png`) });
    await rpc('thread/goal/set', { threadId: firstId, objective: `Ship ${transport} feature and verify its tests`, origin: 'user' });
    await page.waitForFunction(text => document.querySelector('#goalObjectivePreview').textContent === text, `Ship ${transport} feature and verify its tests`);
    await page.locator('#goalButton').click();
    assert(await page.locator('#goalPause').isVisible() && !await page.locator('#goalResume').isVisible(), 'Active goal offers pause only');
    await page.locator('#threadTitle').click();
    assert(!await page.locator('#goalMenu').isVisible(), 'Outside click closes the goal menu');
    await page.locator('#goalButton').click(); await page.locator('#goalPause').click();
    await page.waitForFunction(() => document.querySelector('#goalStatusLabel').textContent === 'Goal paused');
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#goalStatusLabel').textContent === 'Goal paused');
    await page.locator('#goalButton').click();
    assert(!await page.locator('#goalPause').isVisible() && await page.locator('#goalResume').isVisible(), 'Reloaded paused goal offers resume only');
    await page.locator('#goalEdit').click();
    assert(await page.locator('#goalObjective').inputValue() === `Ship ${transport} feature and verify its tests`, 'Edit restores the persisted objective');
    await page.locator('#goalObjective').fill('fixture fail'); await page.locator('#goalSave').click();
    await page.locator('#goalDialogError').waitFor();
    assert((await page.locator('#goalDialogError').textContent()).includes('503'), 'Mutation failures must be visible and actionable');
    assert(await page.locator('#goalObjective').inputValue() === 'fixture fail' && await page.locator('#goalDialog').getAttribute('open') !== null, 'Failed edit retains the draft and editor');
    await page.locator('#goalObjective').fill(`Updated ${transport} objective`); await page.locator('#goalSave').click();
    await page.locator('#goalDialog').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.querySelector('#goalStatusLabel').textContent === 'Goal paused');
    await page.locator('#goalButton').click(); await page.locator('#goalResume').click();
    await page.waitForFunction(() => document.querySelector('#goalStatusLabel').textContent === 'Pursuing goal');
    // Status changes and clears sent by another client must update without a reload.
    for (const [status, label] of Object.entries({ complete: 'Goal achieved', blocked: 'Goal stalled', usageLimited: 'Goal hit usage limits', budgetLimited: 'Goal unmet' })) {
      await rpc('thread/goal/set', { threadId: firstId, status, origin: 'user' });
      await page.waitForFunction(label => document.querySelector('#goalStatusLabel').textContent === label, label);
      await page.locator('#goalButton').click();
      assert(!await page.locator('#goalResume').isVisible(), `${status} must not be misrepresented as user-paused`);
      await page.locator('#goalButton').press('Escape');
    }
    // Thread isolation, including an absent goal in a newly selected thread.
    await page.locator('#newTask').click(); assert(!await page.locator('#goalPicker').isVisible(), 'A new task must immediately hide the previous goal');
    await page.locator('#composerProjectButton').click(); await page.locator('#projectlessOption').click();
    await page.locator('#prompt').fill('/goal'); await page.locator('#prompt').press('Enter');
    await page.locator('#goalDialog[open]').waitFor();
    await page.locator('#goalObjective').fill(`Second ${transport} goal`); await page.locator('#goalSave').click();
    await page.waitForFunction(() => document.querySelector('#goalStatusLabel').textContent === 'Pursuing goal');
    const secondId = (await rpc('thread/list')).data.at(-1).id;
    await page.locator(`.thread-item[data-id="${firstId}"]`).click();
    await page.waitForFunction(() => document.querySelector('#goalStatusLabel').textContent === 'Goal unmet');
    assert(await page.locator('#goalObjectivePreview').textContent() === `Updated ${transport} objective`, 'Thread switch restores the correct objective');
    await rpc('thread/goal/set', { threadId: secondId, status: 'complete', origin: 'user' });
    assert(await page.locator('#goalStatusLabel').textContent() === 'Goal unmet', 'Another thread notification must not leak into the selected thread');

    if (transport === 'ws') {
      // A stale get result captured before a notification must never undo it.
      const gate = { reached: deferred(), release: deferred() }; getGate = gate;
      await page.reload({ waitUntil: 'domcontentloaded' }); await gate.reached.promise;
      await rpc('thread/goal/set', { threadId: firstId, status: 'paused', origin: 'user' });
      await page.waitForFunction(() => document.querySelector('#goalStatusLabel').textContent === 'Goal paused');
      gate.release.resolve();
      await page.waitForFunction(() => document.querySelector('#emptyState') === null);
      assert(await page.locator('#goalStatusLabel').textContent() === 'Goal paused', 'A slow read must not resurrect the pre-pause status');
    }
    await page.setViewportSize({ width: 390, height: 844 });
    if (await page.locator('.sidebar.mobile-open').count()) await page.locator('#toggleSidebar').click();
    await rpc('thread/goal/clear', { threadId: firstId, origin: 'user' });
    await page.locator('#goalPicker').waitFor({ state: 'hidden' });
    const mobileBaseline = await composerGeometry(page);
    await rpc('thread/goal/set', { threadId: firstId, objective: longObjective, status: 'paused', origin: 'user' });
    await page.locator('#goalPicker').waitFor();
    await assertGoalLayout(page, mobileBaseline); await assertGoalEllipsis(page);
    await page.screenshot({ path: artifact(`goal-layout-mobile-${transport}.png`), animations: 'disabled' });
    await page.locator('#goalButton').click();
    const bounds = await page.locator('#goalMenu').boundingBox();
    assert(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 390 && bounds.y >= 0, 'The goal menu must fit a phone viewport');
    await page.screenshot({ path: artifact(`goal-menu-${transport}.png`) });
    await page.locator('#goalDelete').click(); await page.locator('#goalPicker').waitFor({ state: 'hidden' });
    const afterDelete = await composerGeometry(page);
    assert(Math.abs(afterDelete.composer.y - mobileBaseline.composer.y) < 1, 'Deleting a goal restores the original frame height');
    assert((await rpc('thread/goal/get', { threadId: firstId })).goal === null, 'Delete must clear the native goal');
    await page.reload(); await page.locator('#threadTitle').filter({ hasText: first.name }).waitFor({state:'attached'});
    assert(!await page.locator('#goalPicker').isVisible(), 'Deleted goals stay deleted after refresh');
    // Slash controls are handled locally and never become ordinary model messages.
    await page.locator('#prompt').fill('/goal resume'); await page.locator('#prompt').press('Enter');
    await page.locator('#goalError').waitFor();
    assert(await page.locator('#prompt').inputValue() === '/goal resume', 'Rejected slash action must retain its input');
    await context.close();
    console.log(`${transport}: create/edit/pause/resume/complete/clear, reload, thread isolation, errors, mobile and native continuation passed`);
  }
  assert(errors.length === 0, `Browser errors: ${errors.join('; ')}`);
  console.log(JSON.stringify({ transports: ['WebSocket', 'SSE'], browserErrors: errors }));
} finally {
  await browser?.close(); server.kill(); await server.exited; await rm(temporary, { recursive: true, force: true });
}
