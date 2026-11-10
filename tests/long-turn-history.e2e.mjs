import { createServer } from 'node:net';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { chromium, webkit } from 'playwright';
import { artifact, launchOptions, root } from './browser-runtime.mjs';

const assert = (value, message) => { if (!value) throw Error(message); };
const temporary = mkdtempSync(join(homedir(), '.webui-long-turn-'));
for (const name of ['bin', 'codex', 'workspace']) mkdirSync(join(temporary, name));
const cwd = join(temporary, 'workspace'), control = join(temporary, 'control.json'), log = join(temporary, 'rpc.jsonl');
const items = [{ id: 'research-question', type: 'userMessage', content: [{ type: 'text', text: 'Execute the research plan' }] }];
for (let index = 0; index < 2672; index++) {
  if (index % 21 === 0) items.push({ id: `research-edit-${index}`, type: 'fileChange', status: 'completed', changes: [{ path: `${cwd}/result-${index}.py`, kind: 'update', diff: '@@ -1,80 +1,80 @@\n' + Array.from({ length: 80 }, (_, line) => `-old_${line} = 0\n+new_${line} = 1`).join('\n') }] });
  else if (index % 2) items.push({ id: `research-command-${index}`, type: 'commandExecution', status: 'completed', command: `python experiment_${index}.py`, aggregatedOutput: `Output ${index}\n` + 'measured output\n'.repeat(index % 23 === 0 ? 4000 : 60), exitCode: 0 });
  else items.push({ id: `research-reasoning-${index}`, type: 'reasoning', summary: [`Think about experiment ${index}. **Keep the complete history.**`] });
}
items.push({ id: 'research-final', type: 'agentMessage', phase: 'final_answer', text: '**Latest research result.**' });
const turn = { id: 'research-turn', status: 'interrupted', items };
writeFileSync(control, JSON.stringify({ projects: [{ prefix: 'research', cwd, count: 1, threads: [{ turns: [turn] }] }] }));
copyFileSync(join(root, 'tests/fixtures/thread-actions-codex.mjs'), join(temporary, 'bin/codex')); chmodSync(join(temporary, 'bin/codex'), 0o700);
const port = await new Promise(resolve => { const server = createServer(); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); });
const base = `http://127.0.0.1:${port}`;
const server = Bun.spawn([process.execPath, 'run', 'server.ts'], { cwd: root, env: { ...process.env,
  PATH: `${join(temporary, 'bin')}:${dirname(process.execPath)}:${process.env.PATH}`, HOST: '127.0.0.1', PORT: String(port), CODEX_HOME: join(temporary, 'codex'), CODEX_WEBUI_CWD: cwd, CODEX_WEBUI_AUTH_STORE: join(temporary, 'auth.json'), CODEX_WEBUI_PASSWORD: '', CODEX_WEBUI_ACCESS_TOKEN: '', ACTION_FIXTURE_CONTROL: control, ACTION_FIXTURE_LOG: log,
}, stdout: 'ignore', stderr: 'inherit' });
let browser, page, phase = 'startup'; const errors = [], results = [];
try {
  const deadline = Date.now() + 10000;
  while (true) { try { if ((await fetch(base + '/api/health').then(r => r.json())).codex) break; } catch {} if (Date.now() > deadline) throw Error('Fixture did not start'); await Bun.sleep(30); }
  browser = process.env.PLAYWRIGHT_BROWSER === 'webkit' ? await webkit.launch({ headless: true }) : await chromium.launch(launchOptions());
  for (const mobile of [false, true]) {
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 850 }, isMobile: mobile, hasTouch: mobile });
    await context.addInitScript(() => { if (window === window.top) localStorage.setItem('codex-webui-locale', 'en'); });
    page = await context.newPage(); page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
    let navigations = 0; page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations++; });
    phase = `${mobile ? 'mobile' : 'desktop'}: initial history`;
    const started = Date.now();
    await page.goto(base + '/?thread=research-0');
    await page.waitForFunction(() => globalThis.__codexWebuiDebug?.state.connected && !globalThis.__codexWebuiDebug.state.initializing && !globalThis.__codexWebuiDebug.state.threadLoading);
    const initial = await page.locator('#conversation').evaluate(root => ({ nodes: root.querySelectorAll('*').length, events: globalThis.__codexWebuiDebug.state.items.size + [...globalThis.__codexWebuiDebug.state.activityItems.values()].reduce((n, values) => n + values.size, 0), saved: globalThis.__codexWebuiDebug.state.active.turns[0].items.length, hiddenDiffRows: document.querySelectorAll('#changeList .review-line').length, outputText: [...root.querySelectorAll('.activity-output')].reduce((n, output) => n + output.textContent.length, 0), text: root.textContent }));
    assert(initial.events <= 80 && initial.saved === 2674, 'Bound first paint within one giant turn while retaining all original items');
    assert(initial.nodes < 2500 && initial.hiddenDiffRows === 0 && initial.outputText === 0, 'Collapsed history and the closed review panel must not build expensive output trees');
    assert(initial.text.includes('Latest research result.') && initial.text.includes('2594'), 'Show the latest answer and the exact count of earlier items');
    const loadMs = Date.now() - started;
    phase = 'expanded output and older page';
    const command = page.locator('.command-activity').last();
    await command.click();
    assert((await command.evaluate(row => row.nextElementSibling.textContent)).includes('measured output'), 'Expanding a deferred command shows its original output');
    await page.locator('[data-load-earlier-items]').click();
    assert(await page.locator('[data-load-earlier-items]').count() === 1, 'Keep a single earlier-items control');
    const expanded = await page.locator('#conversation').evaluate(() => globalThis.__codexWebuiDebug.state.items.size + [...globalThis.__codexWebuiDebug.state.activityItems.values()].reduce((n, values) => n + values.size, 0));
    assert(expanded === 160, 'Load exactly one additional page without duplicate items');
    phase = 'polling and reload';
    await page.evaluate(turn => globalThis.__codexWebuiDebug.syncTurnSnapshot(turn), turn);
    assert(await page.locator('.command-activity').count() < 160, 'Full polling snapshots must keep the chosen item window');
    const snapshot = { ...turn, status: 'inProgress', items: turn.items.slice(-2049) };
    await page.evaluate(turn => globalThis.__codexWebuiDebug.syncTurnSnapshot(turn), snapshot);
    const polled = await page.evaluate(() => {
      const state = globalThis.__codexWebuiDebug.state;
      return { count: state.items.size + [...state.activityItems.values()].reduce((n, items) => n + items.size, 0), status: state.active.turns[0].status, hidden: state.itemWindows.get('research-turn').hiddenCount };
    });
    assert(polled.count === 160 && polled.hidden === 1889 && polled.status === 'interrupted', `A shorter native/live snapshot keeps the item budget and stopped state: ${JSON.stringify(polled)}`);
    await page.evaluate(turn => globalThis.__codexWebuiDebug.syncTurnSnapshot(turn), turn);
    await page.locator('#toggleSidePanel').click(); await page.locator('[data-side-panel-action=review]').click();
    assert(await page.locator('.review-file').count() === items.filter(item => item.type === 'fileChange').length, 'The review keeps changes from the complete turn, including hidden history');
    await page.locator('#closeSidePanel').click();
    await page.reload(); await page.waitForFunction(() => globalThis.__codexWebuiDebug?.state.connected && !globalThis.__codexWebuiDebug.state.initializing && !globalThis.__codexWebuiDebug.state.threadLoading);
    const reloadControls = await page.locator('[data-load-earlier-items]').count();
    assert(reloadControls === 1 && navigations === 2, `Reload restores a bounded window without a reload loop (controls=${reloadControls}, navigations=${navigations})`);
    const calls = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    assert(!calls.some(call => ['turn/start', 'turn/interrupt', 'thread/delete'].includes(call.method)), 'Viewing and paging history never changes the task');
    results.push({ mobile, loadMs, initialNodes: initial.nodes, initialEvents: initial.events, completeItems: initial.saved });
    await page.screenshot({ path: artifact(`long-turn-${mobile ? 'mobile' : 'desktop'}.png`) });
    await context.close();
  }
  assert(!errors.length, errors.join('; '));
  console.log(JSON.stringify({ ok: true, results, errors }));
} catch (error) {
  console.error('Phase:', phase, error, 'Browser errors:', errors); throw error;
} finally { await browser?.close(); server.kill(); await server.exited; rmSync(temporary, { recursive: true, force: true }); }
