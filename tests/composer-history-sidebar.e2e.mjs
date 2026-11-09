import { createServer } from 'node:net';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';
import { artifact, launchOptions, root } from './browser-runtime.mjs';

const assert = (value, message) => { if (!value) throw Error(message); };
const temporary = mkdtempSync(join(tmpdir(), 'webui-composer-history-sidebar-'));
for (const name of ['bin', 'codex', 'workspace']) mkdirSync(join(temporary, name));
const control = join(temporary, 'control.json'), log = join(temporary, 'rpc.jsonl');
const projects = [{ prefix: 'recent', cwd: join(temporary, 'recent'), count: 13, threads: Array.from({ length: 13 }, (_, i) => ({ recencyAt: 1900000000 + i })) }, { prefix: 'large', cwd: join(temporary, 'large'), count: 122 }];
for (const project of projects) mkdirSync(project.cwd);
let settings = { projects, occupiedIds: ['parent-ws', 'parent-sse'] };
const configure = changes => { Object.assign(settings, changes); writeFileSync(control + '.next', JSON.stringify(settings)); renameSync(control + '.next', control); }; configure({});
copyFileSync(join(root, 'tests/fixtures/thread-actions-codex.mjs'), join(temporary, 'bin/codex')); chmodSync(join(temporary, 'bin/codex'), 0o700);
const port = await new Promise(resolve => { const probe = createServer(); probe.listen(0, '127.0.0.1', () => { const value = probe.address().port; probe.close(() => resolve(value)); }); });
const base = `http://127.0.0.1:${port}`;
const server = Bun.spawn([process.execPath, 'run', 'server.ts'], { cwd: root, env: { ...process.env,
  PATH: `${join(temporary, 'bin')}:${dirname(process.execPath)}:${process.env.PATH}`, HOST: '127.0.0.1', PORT: String(port), CODEX_HOME: join(temporary, 'codex'), CODEX_WEBUI_CWD: join(temporary, 'workspace'), CODEX_WEBUI_AUTH_STORE: join(temporary, 'auth.json'), CODEX_WEBUI_PASSWORD: '', CODEX_WEBUI_ACCESS_TOKEN: '', ACTION_FIXTURE_CONTROL: control, ACTION_FIXTURE_LOG: log,
}, stdout: 'ignore', stderr: 'inherit' });
const protocol = () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const ready = page => page.waitForFunction(() => globalThis.__codexWebuiDebug?.state.connected && !globalThis.__codexWebuiDebug.state.initializing && !globalThis.__codexWebuiDebug.state.threadLoading);
let browser, page, phase = 'startup'; const errors = [], results = [];
try {
  const deadline = Date.now() + 10000;
  while (true) { try { if ((await fetch(base + '/api/health').then(r => r.json())).codex) break; } catch {} if (Date.now() > deadline) throw Error('Fixture did not start'); await Bun.sleep(30); }
  browser = await chromium.launch(launchOptions());
  for (const transport of ['ws', 'sse']) {
    const id = `parent-${transport}`;
    configure({ occupiedIds: [id], resumeDelay: 0, resumeReject: false, fork: 'ok' });
    const context = await browser.newContext({ viewport: { width: 1280, height: 850 }, colorScheme: 'light' });
    await context.addInitScript(() => { if (window === window.top) localStorage.setItem('codex-webui-locale', 'en'); });
    page = await context.newPage(); page.setDefaultTimeout(8000); page.on('pageerror', error => errors.push(error.message));
    if (transport === 'sse') await page.routeWebSocket('**/ws', socket => socket.close());
    phase = transport + ': occupied composer';
    await page.goto(`${base}/?thread=${id}`); await ready(page);
    assert(await page.locator('#threadLocked').isVisible() && await page.locator('#composer').isHidden(), 'Show a lock panel immediately from the native ownership state');
    assert(await page.locator('.user-message-text').count() === 2, 'Occupied sessions still show their readable history');
    assert(!protocol().some(call => call.method === 'thread/resume' && call.params.threadId === id), 'Reading a session does not acquire or probe its writer lock');
    const starts = protocol().filter(call => call.method === 'turn/start').length;
    await page.keyboard.press('Escape');
    assert(protocol().filter(call => call.method === 'turn/start').length === starts, 'Opening or checking ownership never starts model work');
    await page.locator('#retryThread').click(); await page.waitForFunction(() => !document.querySelector('#retryThread').disabled);
    assert(await page.locator('#threadLocked').isVisible(), 'A failed retry stays locked');
    await page.screenshot({ path: artifact(`occupied-composer-${transport}.png`) });
    configure({ occupiedIds: [] }); await page.locator('#retryThread').click(); await page.locator('#composer').waitFor();
    assert(await page.locator('#prompt').evaluate(node => node === document.activeElement), 'Successful retry restores and focuses the composer');

    phase = transport + ': history keys';
    const input = page.locator('#prompt');
    await input.press('ArrowUp'); assert(await input.inputValue() === 'Later question', 'Up recalls the latest native input');
    await input.press('ArrowUp'); assert(await input.inputValue() === 'First question', 'Up recalls older input');
    await input.press('ArrowDown'); assert(await input.inputValue() === 'Later question', 'Down recalls newer input');
    await input.press('ArrowDown'); assert(await input.inputValue() === '', 'Down returns to an empty draft');
    await input.press('ArrowUp'); await input.press('ArrowLeft'); await input.press('ArrowUp');
    assert(await input.inputValue() === 'Later question', 'Moving the caret exits history navigation');
    await input.fill(''); await input.press('ArrowUp'); await input.press('x'); const edited = await input.inputValue(); await input.press('ArrowUp');
    assert(await input.inputValue() === edited, 'Typing exits history navigation');
    await input.fill('A draft'); await input.press('ArrowUp'); assert(await input.inputValue() === 'A draft', 'An existing draft is never replaced');
    await input.fill(''); await input.press('ArrowUp'); await input.click(); await input.press('ArrowUp'); assert(await input.inputValue() === 'Later question', 'Pointer caret placement also exits history navigation');
    await input.fill('');
    const ime = await input.evaluate(node => { const event = new KeyboardEvent('keydown', { key: 'ArrowUp', isComposing: true, bubbles: true, cancelable: true }); node.dispatchEvent(event); return { prevented: event.defaultPrevented, value: node.value }; });
    assert(!ime.prevented && !ime.value, 'IME arrow keys remain available to the input method');
    await input.fill('/'); await page.locator('#composerAutocomplete:not([hidden])').waitFor();
    const selected = await page.locator('.autocomplete-item[aria-selected=true]').getAttribute('data-autocomplete-id');
    await input.press('ArrowDown'); assert(await page.locator('.autocomplete-item[aria-selected=true]').getAttribute('data-autocomplete-id') !== selected && await input.inputValue() === '/', 'Slash autocomplete takes precedence over input history');
    await input.press('Escape');
    const multiline = `Two lines ${transport}\nsecond line`;
    await input.fill(multiline); await input.press('Enter'); await page.waitForFunction(() => !!document.querySelector('#sendButton').dataset.turnId);
    await input.press('Escape'); await page.waitForFunction(() => !document.querySelector('#sendButton').dataset.turnId);
    await input.press('ArrowUp'); assert(await input.inputValue() === multiline, 'Recall multiline submissions intact');
    await page.reload(); await ready(page); await input.press('ArrowUp'); assert(await input.inputValue() === multiline, 'Native session history remains recallable after refresh');
    await page.locator('#newTask').click(); await input.press('ArrowUp'); assert(await input.inputValue() === multiline, 'A new blank chat can recall this browser’s previous submissions');

    phase = transport + ': lock errors and independent branches';
    configure({ occupiedIds: [id] }); await page.evaluate(id => globalThis.__codexWebuiDebug.openThread(id), id);
    assert(await page.locator('#threadLocked').isVisible(), 'Reopening an occupied thread rechecks ownership');
    configure({ fork: 'reject' }); await page.locator('#forkLockedThread').click(); await page.waitForFunction(() => !document.querySelector('#forkLockedThread').disabled);
    assert(await page.locator('#threadLocked').isVisible(), 'Failed branching preserves the original lock and history');
    configure({ fork: 'ok' }); const forks = protocol().filter(call => call.method === 'thread/fork').length;
    await page.locator('#forkLockedThread').click(); await page.locator('#forkLockedThread').dispatchEvent('click');
    await page.waitForFunction(() => globalThis.__codexWebuiDebug.state.active?.id.startsWith('branch-') && !globalThis.__codexWebuiDebug.state.threadLoading);
    assert(protocol().filter(call => call.method === 'thread/fork').length === forks + 1, 'Duplicate clicks create only one independent branch');
    assert(await page.locator('#composer').isVisible() && await page.locator('.user-message-text').count() === 3, 'A branch receives the complete original history and an editable composer');
    const fork = protocol().filter(call => call.method === 'thread/fork').at(-1);
    assert(fork.params.deferGoalContinuation === true && !fork.params.lastTurnId, 'Fork the complete chat without starting a continuation');
    assert(await page.locator('#threadTitle').textContent() === `分支 · Actions fixture ${transport}`, 'Preserve branch naming conventions');
    await page.evaluate(id => globalThis.__codexWebuiDebug.openThread(id), id);
    configure({ resumeDelay: 500 }); await page.locator('#retryThread').click();
    const race = await page.evaluate(async () => { const api = globalThis.__codexWebuiDebug; await api.openThread('recent-0'); await new Promise(resolve => setTimeout(resolve, 650)); return api.state.active.id; });
    assert(race === 'recent-0' && await page.locator('#composer').isVisible() && await page.locator('#threadLocked').isHidden(), 'A late ownership conflict never locks another selected chat');
    configure({ resumeDelay: 0, occupiedIds: [] });

    phase = transport + ': recent project pages';
    await page.locator('#newTask').click(); await input.fill(''); await page.reload(); await ready(page);
    assert(await page.evaluate(() => globalThis.__codexWebuiDebug.state.threads.length) >= 137, 'Sidebar loads beyond the first native page');
    const group = page.locator(`.sidebar-project-group[data-project="${projects[0].cwd}"]`), rows = group.locator('.thread-item');
    if (await group.locator('.sidebar-project-row').getAttribute('aria-expanded') !== 'true') await group.locator('.sidebar-project-row').click();
    assert(await rows.count() === 5, 'Projects initially show five sessions');
    assert(JSON.stringify(await rows.evaluateAll(nodes => nodes.map(node => node.dataset.id))) === JSON.stringify(['recent-12', 'recent-11', 'recent-10', 'recent-9', 'recent-8']), 'Order uses last recency rather than source list order');
    await group.locator('.sidebar-show-more').click(); assert(await rows.count() === 10, 'Each expansion adds five');
    await group.locator('.sidebar-show-more').click(); assert(await rows.count() === 13 && await group.locator('.sidebar-show-more').count() === 0, 'The last page shows the remaining sessions and hides the button');
    await page.locator('#sidebarSearchButton').click(); await page.locator('#threadSearch').fill('large chat 121');
    assert(await page.locator('#threadList .thread-item').count() === 1, 'Search includes sessions beyond the first native page');
    await page.locator('#threadSearch').fill(''); await page.locator('#sidebarSearchClose').click();
    await page.evaluate(() => globalThis.__codexWebuiDebug.openThread('large-121'));
    assert(await page.locator('.thread-item[data-id="large-121"]').isVisible(), 'Direct navigation reveals the selected older session');

    phase = transport + ': responsive sidebar';
    assert(await page.locator('#closeSidebar').isVisible(), 'Desktop sidebar has a collapse button next to Search');
    assert(await page.locator('#closeSidebar path').getAttribute('d') === 'm15 18-6-6 6-6', 'Collapse control uses the left chevron');
    await page.locator('#closeSidebar').click(); await page.waitForFunction(() => document.body.classList.contains('sidebar-hidden'));
    await page.locator('#toggleSidebar').click(); await page.waitForFunction(() => !document.body.classList.contains('sidebar-hidden'));
    await page.setViewportSize({ width: 390, height: 844 }); await page.waitForFunction(() => !document.querySelector('#sidebar').classList.contains('mobile-open'));
    await page.locator('#toggleSidebar').click(); await page.locator('#sidebar.mobile-open').waitFor();
    assert((await page.locator('#sidebar').evaluate(node => getComputedStyle(node).boxShadow)).includes('0.14'), 'Narrow sidebar shadow has reduced opacity');
    await page.screenshot({ path: artifact(`sidebar-mobile-${transport}.png`) });
    await page.locator('#closeSidebar').click(); await page.waitForFunction(() => !document.querySelector('#sidebar').classList.contains('mobile-open'));
    await page.evaluate(id => globalThis.__codexWebuiDebug.openThread(id), id); configure({ occupiedIds: [id] });
    await page.reload(); await ready(page); await page.locator('#threadLocked').waitFor();
    const layout = await page.locator('#threadLocked').evaluate(node => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, width: innerWidth, overflow: document.documentElement.scrollWidth > innerWidth }; });
    assert(layout.left >= 0 && layout.right <= layout.width && !layout.overflow, 'Lock panel and actions fit a narrow window');
    await page.screenshot({ path: artifact(`occupied-composer-mobile-${transport}.png`) });
    results.push({ transport, occupiedRetryAndFork: true, navigationRace: true, nativeAndNewChatHistory: true, editExitsHistory: true, imeAndAutocomplete: true, recentPages: [5, 10, 13], allNativePages: true, responsiveSidebar: true });
    await context.close(); page = null;
  }
  assert(!errors.length, `Browser errors: ${errors.join('; ')}`); console.log(JSON.stringify({ results, errors }, null, 2));
} catch (error) {
  console.error('Phase:', phase, error, 'Browser errors:', errors);
  if (page) await page.screenshot({ path: artifact('composer-history-sidebar-failure.png'), timeout: 2000 }).catch(() => {});
  throw error;
} finally { if (browser) await browser.close(); server.kill(); await server.exited; rmSync(temporary, { recursive: true, force: true }); }
