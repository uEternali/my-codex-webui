import { createServer } from 'node:net';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';
import { artifact, launchOptions, root } from './browser-runtime.mjs';
const assert = (value, message) => { if (!value) throw Error(message); };
const temporary = await mkdtemp(join(tmpdir(), 'webui-thread-management-'));
const bin = join(temporary, 'bin'), home = join(temporary, 'codex'), log = join(temporary, 'rpc.jsonl'), control = join(temporary, 'control.json');
await mkdir(bin); await mkdir(home); await writeFile(log, '');
let settings = { finish: 0, omitForks: true, archiveCount: 18 };
const configure = async changes => { Object.assign(settings, changes); await writeFile(control + '.next', JSON.stringify(settings)); await rename(control + '.next', control); };
await configure({}); await copyFile(join(root, 'tests/fixtures/thread-actions-codex.mjs'), join(bin, 'codex')); await chmod(join(bin, 'codex'), 0o700);
const port = await new Promise(resolve => { const probe = createServer(); probe.listen(0, '127.0.0.1', () => { const value = probe.address().port; probe.close(() => resolve(value)); }); });
const base = `http://127.0.0.1:${port}`;
const server = Bun.spawn([process.execPath, 'run', 'server.ts'], { cwd: root, env: { ...process.env, PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH}`, HOST: '127.0.0.1', PORT: String(port), CODEX_HOME: home, CODEX_WEBUI_CWD: homedir(), CODEX_WEBUI_AUTH_STORE: join(temporary, 'auth.json'), CODEX_WEBUI_PASSWORD: '', CODEX_WEBUI_ACCESS_TOKEN: '', ACTION_FIXTURE_LOG: log, ACTION_FIXTURE_CONTROL: control }, stdout: 'ignore', stderr: 'inherit' });
const protocol = async () => (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
const rpc = async (method, params) => fetch(base + '/api/rpc', { method: 'POST', headers: { 'content-type': 'application/json', Origin: base }, body: JSON.stringify({ id: 900, method, params }) }).then(response => response.json());
let browser, phase = 'starting'; const errors = [], results = [];
try {
  const deadline = Date.now() + 15000;
  while (true) { try { if ((await fetch(base + '/api/health').then(r => r.json())).codex) break; } catch {} if (Date.now() > deadline) throw Error('Fixture startup timeout'); await Bun.sleep(40); }
  browser = await chromium.launch(launchOptions());
  for (const transport of ['ws', 'sse']) {
    await configure({ rename: 'ok', archive: 'ok', delete: 'ok' });
    const context = await browser.newContext({ viewport: { width: 1120, height: 850 } });
    await context.addInitScript(() => { if (window === window.top && !localStorage.getItem('codex-webui-locale')) localStorage.setItem('codex-webui-locale', 'en'); });
    const page = await context.newPage(); page.setDefaultTimeout(9000); page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => { errors.push(`Unexpected browser dialog: ${dialog.message()}`); void dialog.dismiss(); });
    if (transport === 'sse') await page.routeWebSocket('**/ws', socket => socket.close());
    await page.goto(base); await page.waitForFunction(() => globalThis.__codexWebuiDebug?.state.connected);
    const parent = `parent-${transport}`, parentName = `Actions fixture ${transport}`;
    await page.evaluate(id => globalThis.__codexWebuiDebug.openThread(id), parent);
    const row = id => page.locator(`.thread-item[data-id="${id}"]`);
    const action = async (id, selector) => { await row(id).hover(); await row(id).locator(selector).click(); };
    const more = async id => { await action(id, '.thread-more'); await page.locator('#threadActionsMenu').waitFor(); };
    const archive = async id => { await more(id); await page.getByRole('menuitem', { name: 'Archive chat', exact: true }).click(); };
    const answerConfirmation = async accept => {
      const dialog = page.locator('#confirmationDialog'); await dialog.waitFor();
      await dialog.locator(`[value="${accept ? 'confirm' : 'cancel'}"]`).click();
      await dialog.waitFor({ state: 'hidden' });
    };
    phase = transport + ': menu'; await more(parent);
    assert(await page.locator('#threadActionsMenu [role="menuitem"] svg').count() === 3, 'Every ellipsis menu item has an icon');
    const menuGeometry = await page.locator('#threadActionsMenu').boundingBox();
    assert(menuGeometry.x >= 0 && menuGeometry.y >= 0 && menuGeometry.x + menuGeometry.width <= 1120 && menuGeometry.y + menuGeometry.height <= 850, 'Portalled menu is inside the viewport and outside collapsing project containers');
    await page.locator('#threadTitle').hover();
    assert(await row(parent).locator('.thread-actions').evaluate(node => getComputedStyle(node).opacity) === '1', 'Row actions remain visible while the menu is open, even when focus and pointer leave the row');
    await page.locator('#threadTitle').click(); assert(await page.locator('#threadActionsMenu').isHidden(), 'Outside clicks close the menu');
    await more(parent); await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
    assert(await page.locator('#renameThreadName').inputValue() === parentName, 'Rename input is prefilled');
    await page.locator('#renameThreadName').fill('   '); await page.locator('#renameThreadSave').click();
    await page.getByText('Enter a chat name', { exact: true }).waitFor();
    await page.locator('#renameThreadName').fill('Save');
    const renameCallsBefore = (await protocol()).filter(call => call.method === 'thread/name/set').length;
    await page.locator('#renameThreadName').dispatchEvent('compositionstart'); await page.locator('#renameThreadName').press('Enter');
    assert((await protocol()).filter(call => call.method === 'thread/name/set').length === renameCallsBefore, 'IME confirmation never submits a rename');
    await page.locator('#renameThreadName').dispatchEvent('compositionend');
    await configure({ rename: 'reject' }); await page.locator('#renameThreadSave').click();
    await page.locator('#renameThreadError').getByText('Could not rename chat: HTTP 503: name service unavailable', { exact: true }).waitFor();
    assert(await page.locator('#renameThreadName').inputValue() === 'Save', 'Failed saves keep the draft and dialog open');
    await configure({ rename: 'ok' }); await page.locator('#renameThreadSave').click();
    await page.locator('#renameThreadDialog').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.querySelector('#threadTitle').textContent === 'Save');
    await page.reload(); await row(parent).waitFor();
    assert(await page.locator('#threadTitle').textContent() === 'Save', 'Rename survives refresh in both sidebar and active title');
    phase = transport + ': pin';
    await action(parent, '.thread-pin'); await page.locator(`#pinnedThreadList .thread-item[data-id="${parent}"]`).waitFor();
    assert(await row(parent).locator('.thread-pin').getAttribute('aria-pressed') === 'true', 'Pin state is exposed accessibly');
    const order = await row(parent).locator('.thread-actions button').evaluateAll(nodes => nodes.map(node => node.className));
    assert(order.length === 2 && order[0].includes('thread-pin') && order[1].includes('thread-more'), 'Row actions are pin and ellipsis; archive lives in the menu');
    await page.reload(); await page.locator(`#pinnedThreadList .thread-item[data-id="${parent}"]`).waitFor();
    const stored = JSON.parse(await readFile(join(home, 'codex-webui-pins.json'), 'utf8'));
    assert(stored.pins.some(pin => pin.id === parent), 'Pin preferences live in the server Codex home');
    const separate = await browser.newContext(); const secondPage = await separate.newPage(); await secondPage.goto(base);
    await secondPage.locator(`#pinnedThreadList .thread-item[data-id="${parent}"]`).waitFor(); await separate.close();
    await action(parent, '.thread-pin'); await page.locator(`#threadList .thread-item[data-id="${parent}"]`).waitFor();
    phase = transport + ': running';
    const other = transport === 'ws' ? 'parent-sse' : 'parent-ws';
    const backgroundEvents = await page.evaluate(id => {
      const api = globalThis.__codexWebuiDebug, result = [];
      for (const status of ['completed', 'interrupted', 'failed']) {
        api.notify('turn/started', { threadId: id, turn: { id: 'background-indicator' } });
        const running = !document.querySelector(`.thread-item[data-id="${id}"] .thread-running-indicator`).hidden;
        api.notify('turn/completed', { threadId: id, turn: { id: 'background-indicator', status } });
        const stopped = document.querySelector(`.thread-item[data-id="${id}"] .thread-running-indicator`).hidden;
        result.push({ status, running, stopped, selected: api.state.active.id });
      }
      return result;
    }, other);
    assert(backgroundEvents.every(result => result.running && result.stopped && result.selected === parent), `Background lifecycle updates the sidebar without changing conversations: ${JSON.stringify(backgroundEvents)}`);
    // Menu and dialog Escape must not accidentally interrupt the running task.
    await page.locator('#prompt').fill('A running fixture task'); await page.locator('#prompt').press('Enter');
    await page.waitForFunction(() => !!document.querySelector('#sendButton').dataset.turnId);
    await row(parent).locator('.thread-running-indicator').waitFor({ state: 'visible' });
    await page.locator('#threadTitle').hover();
    assert(await row(parent).locator('time').isVisible(), 'Running status leaves the timestamp visible before hover');
    const indicatorLayout = await row(parent).evaluate(node => {
      const name = node.querySelector('.thread-name').getBoundingClientRect(), spinner = node.querySelector('.thread-running-indicator').getBoundingClientRect(), time = node.querySelector('time').getBoundingClientRect();
      return name.right <= spinner.left && spinner.right <= time.left && spinner.width === 14 && getComputedStyle(node.querySelector('.thread-running-indicator svg')).animationName === 'spin';
    });
    assert(indicatorLayout, 'Spinner sits between the truncated title and the timestamp');
    await page.screenshot({ path: artifact(`thread-running-${transport}.png`) });
    await more(parent); await page.getByRole('menuitem', { name: 'Rename', exact: true }).press('Escape');
    assert(await page.locator('#threadActionsMenu').isHidden(), 'Escape closes the menu');
    assert(await page.locator('#sendButton').getAttribute('data-turn-id'), 'Closing menu does not stop a task');
    await more(parent);
    assert(await page.getByRole('menuitem', { name: 'Archive chat', exact: true }).isDisabled(), 'Running chats cannot be archived accidentally');
    const hoverLayout = await row(parent).evaluate(node => {
      const spinner = node.querySelector('.thread-running-indicator').getBoundingClientRect(), pin = node.querySelector('.thread-pin').getBoundingClientRect(), more = node.querySelector('.thread-more').getBoundingClientRect();
      return spinner.right <= pin.left && pin.right <= more.left;
    });
    assert(hoverLayout && await row(parent).locator('.thread-running-indicator').isVisible(), 'Spinner remains visible to the left of pin and ellipsis on hover');
    await page.getByRole('menuitem', { name: 'Rename', exact: true }).press('Escape');
    await more(parent); await page.getByRole('menuitem', { name: 'Rename', exact: true }).click(); await page.locator('#renameThreadName').press('Escape');
    assert(await page.locator('#renameThreadDialog').isHidden(), 'Escape closes the rename dialog');
    assert(await page.locator('#sendButton').getAttribute('data-turn-id'), 'Closing dialog does not stop a task');
    const deleteBeforeEscape = (await protocol()).filter(call => call.method === 'thread/delete').length;
    await more(parent); await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
    await page.locator('#confirmationDialog').waitFor();
    assert(await page.locator('#confirmationDialog [value="cancel"]').evaluate(node => document.activeElement === node), 'Delete confirmation focuses Cancel');
    await page.locator('#confirmationDialog [value="cancel"]').press('Escape');
    await page.locator('#confirmationDialog').waitFor({ state: 'hidden' });
    assert(await page.locator('#sendButton').getAttribute('data-turn-id'), 'Escape in delete confirmation leaves the running task untouched');
    assert((await protocol()).filter(call => call.method === 'thread/delete').length === deleteBeforeEscape, 'Escape cancels deletion before any mutation');
    await page.reload(); await row(parent).locator('.thread-running-indicator').waitFor({ state: 'visible' });
    await row(other).click(); await page.waitForFunction(id => globalThis.__codexWebuiDebug.state.active?.id === id, other);
    assert(await row(parent).locator('.thread-running-indicator').isVisible(), 'Switching conversations preserves background running indicators');
    await page.reload(); await row(parent).locator('.thread-running-indicator').waitFor({ state: 'visible' });
    await row(parent).click(); await page.waitForFunction(() => !!document.querySelector('#sendButton').dataset.turnId);
    await page.locator('#prompt').press('Escape'); await page.waitForFunction(() => !document.querySelector('#sendButton').dataset.turnId);
    await row(parent).locator('.thread-running-indicator').waitFor({ state: 'hidden' });
    phase = transport + ': fork';
    // A native fork with no new messages remains named and manageable through archives.
    await page.locator(`[data-turn-id="${parent}-first"] [data-fork-reply]`).click();
    await page.waitForFunction(() => globalThis.__codexWebuiDebug.state.active?.id.startsWith('branch-'));
    const branch = await page.evaluate(() => globalThis.__codexWebuiDebug.state.active.id);
    assert(await page.locator('#threadTitle').textContent() === '分支 · Save', 'Default fork name uses the original name');
    await rpc('thread/list', { limit: 50 }); // Populate the hidden-fork metadata cache.
    await more(branch); await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
    await page.locator('#renameThreadName').fill('Renamed empty branch'); await page.locator('#renameThreadSave').click();
    await page.locator('#renameThreadDialog').waitFor({ state: 'hidden' }); await page.reload(); await row(branch).waitFor();
    assert(await row(branch).locator('.thread-name').textContent() === 'Renamed empty branch', 'Native metadata cache is invalidated when an empty fork is renamed');
    await action(branch, '.thread-pin'); await page.locator(`#pinnedThreadList .thread-item[data-id="${branch}"]`).waitFor();
    phase = transport + ': archive';
    await configure({ archive: 'reject' }); await archive(branch);
    await page.getByText('Could not archive chat: HTTP 503: archive service unavailable', { exact: true }).waitFor();
    assert(await row(branch).count() === 1, 'Failed archive retains the chat');
    await configure({ archive: 'ok' }); await archive(branch); await page.locator(`#pinnedThreadList [data-id="${branch}"]`).waitFor({ state: 'detached' });
    if (await page.locator('#archiveThreadsButton').getAttribute('aria-expanded') !== 'true') await page.locator('#archiveThreadsButton').click();
    await page.locator(`#archivedThreadList [data-id="${branch}"]`).waitFor();
    assert(!(await rpc('thread/list', { limit: 50 })).result.data.some(thread => thread.id === branch), 'Archived empty forks cannot resurrect in the active list');
    assert((await rpc('thread/list', { archived: true, limit: 50 })).result.data.some(thread => thread.id === branch), 'Archived empty forks are included in the archive list');
    await page.reload(); await page.locator(`#archivedThreadList [data-id="${branch}"]`).waitFor();
    assert(await page.locator(`#archivedThreadList [data-id="${branch}"] .thread-actions button svg`).count() === 2, 'Archive rows have permanent-delete and restore icons');
    assert(await row(branch).locator('time').isVisible(), 'Archived chats display the date and time before hover, just like project chats');
    assert(/\d{2}\/\d{2} \d{2}:\d{2}/.test(await row(branch).locator('time').textContent()), 'Archive timestamp includes both date and hours/minutes');
    await page.locator('#archiveThreadsButton').click();
    const collapsedArchiveTop = (await page.locator('#archiveThreadsButton').boundingBox()).y;
    await page.locator('#archiveThreadsButton').click();
    const archiveLayout = await page.evaluate(collapsedTop => {
      const list = document.querySelector('#archivedThreadList'), toggle = document.querySelector('#archiveThreadsButton').getBoundingClientRect(), footer = document.querySelector('.sidebar-footer').getBoundingClientRect(), rect = list.getBoundingClientRect();
      const initial = toggle.top; list.scrollTop = list.scrollHeight; const fixed = document.querySelector('#archiveThreadsButton').getBoundingClientRect().top === initial; list.scrollTop = 0;
      return { below: rect.top >= toggle.bottom - 1, movedUp: toggle.top < collapsedTop - 20, bottom: footer.top - rect.bottom, scrolling: list.scrollHeight > list.clientHeight && getComputedStyle(list).overflowY === 'auto', fixed };
    }, collapsedArchiveTop);
    assert(archiveLayout.below && archiveLayout.movedUp && archiveLayout.bottom >= 0 && archiveLayout.bottom < 14 && archiveLayout.scrolling && archiveLayout.fixed, `Archive title moves upward with its scrollable list below it: ${JSON.stringify(archiveLayout)}`);
    const archiveScrollRetained = await page.evaluate(id => {
      const list = document.querySelector('#archivedThreadList'); list.scrollTop = 120; const before = list.scrollTop;
      globalThis.__codexWebuiDebug.notify('host/thread/pinned', { threadId: id, pinnedAt: null });
      const retained = before > 0 && list.scrollTop === before; list.scrollTop = 0; return retained;
    }, parent);
    assert(archiveScrollRetained, 'Refreshing project or pin metadata preserves the archive scroll position');


    await configure({ archive: 'reject' }); await action(branch, '.thread-restore');
    await page.getByText('Could not restore chat: HTTP 503: archive service unavailable', { exact: true }).waitFor();
    await configure({ archive: 'ok' }); await action(branch, '.thread-restore');
    await page.locator(`#threadList [data-id="${branch}"]`).waitFor();
    assert(await page.locator(`#pinnedThreadList [data-id="${branch}"]`).count() === 0, 'Restoring returns to the original project instead of pinning again');
    assert(await row(branch).locator('xpath=..').getAttribute('class') === 'sidebar-project-threads expanded', 'Restore expands the original project');
    phase = transport + ': delete';
    // Retain application confirmation and show errors for permanent deletion.
    await more(branch); await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
    await page.locator('#confirmationDialog').waitFor();
    assert((await page.locator('#confirmationHint').textContent()).includes('Independent branches will be kept'), 'Page confirmation retains the deletion scope');
    await answerConfirmation(false);
    assert(await row(branch).count() === 1, 'Cancel preserves a chat');
    await configure({ delete: 'reject' }); await more(branch); await page.getByRole('menuitem', { name: 'Delete', exact: true }).click(); await answerConfirmation(true);
    await page.getByText('Could not delete thread: HTTP 503: deletion unavailable', { exact: true }).waitFor();
    await configure({ delete: 'ok' });
    await archive(branch); await page.locator(`#archivedThreadList [data-id="${branch}"]`).waitFor();
    await action(branch, '.thread-delete'); await answerConfirmation(true); await row(branch).waitFor({ state: 'detached' });
    assert(!(await rpc('thread/list', { archived: true })).result.data.some(thread => thread.id === branch), 'Permanent deletion also removes archived fork registrations');
    phase = transport + ': mobile';
    // Narrow viewports keep the menu unclipped and every action reachable.
    await rpc('turn/start', { threadId: parent, input: [{ type: 'text', text: 'Mobile sidebar running fixture' }] });
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 560 });
      await page.waitForFunction(() => getComputedStyle(document.querySelector('#sidebar')).position === 'fixed');
      await page.evaluate(() => { dispatchEvent(new Event('resize')); globalThis.__codexWebuiDebug.setSidebarOpen(true); });
      await page.locator('#sidebar.mobile-open').waitFor();
      await page.waitForFunction(() => document.querySelector('#sidebar').getBoundingClientRect().left >= 0);
      await row(parent).locator('.thread-running-indicator').waitFor({ state: 'visible' });
      await more(parent);
      const compactLayout = await row(parent).evaluate(node => {
        const spinner = node.querySelector('.thread-running-indicator').getBoundingClientRect(), actions = node.querySelector('.thread-actions').getBoundingClientRect(), row = node.getBoundingClientRect();
        return spinner.width === 14 && spinner.right <= actions.left && actions.right <= row.right;
      });
      assert(compactLayout, `Running indicator and actions fit the ${width}px sidebar`);
      const box = await page.locator('#threadActionsMenu').boundingBox();
      assert(box.x >= 0 && box.x + box.width <= width && box.y + box.height <= 560, `Menu fits ${width}px viewport`);
      await page.getByRole('menuitem', { name: 'Rename', exact: true }).press('Escape');
      await more(parent); await page.getByRole('menuitem', { name: 'Delete', exact: true }).click(); await page.locator('#confirmationDialog').waitFor();
      const modal = await page.locator('#confirmationDialog').boundingBox();
      assert(modal.x >= 0 && modal.x + modal.width <= width && modal.y >= 0 && modal.y + modal.height <= 560, `Delete confirmation fits ${width}px viewport`);
      await answerConfirmation(false);
    }
    await rpc('turn/interrupt', { threadId: parent });
    phase = transport + ': localization';
    await page.setViewportSize({ width: 1120, height: 850 });
    await page.evaluate(() => localStorage.setItem('codex-webui-locale', 'zh-CN')); await page.reload();
    await page.getByRole('button', { name: '归档', exact: true }).waitFor();
    assert(await row(parent).locator('.thread-name').textContent() === 'Save', 'User-defined titles are not translated along with UI labels');
    await more(parent); await page.getByRole('menuitem', { name: '重命名', exact: true }).click();
    await page.getByRole('heading', { name: '重命名聊天', exact: true }).waitFor();
    await page.screenshot({ path: artifact(`thread-management-${transport}.png`) });
    await page.locator('#renameThreadCancel').click();
    await more(parent); await page.getByRole('menuitem', { name: '删除', exact: true }).click();
    await page.getByRole('heading', { name: '永久删除聊天', exact: true }).waitFor();
    assert((await page.locator('#confirmationHint').textContent()).includes('Save'), 'Localized confirmation preserves the user-defined chat name');
    await answerConfirmation(false);
    results.push({ transport, branchName: '分支 · Save', rename: true, pinPersistence: true, archiveRestore: true, permanentDelete: true, menuIcons: 3, runningIndicator: true, backgroundLifecycle: true, runningReload: true });
    await context.close();
  }
  assert(errors.length === 0, errors.join('\n'));
  console.log(JSON.stringify({ ok: true, results }));
} catch (error) { console.error('Phase:', phase); console.error('Browser errors:', errors); console.error('Recent RPC:', JSON.stringify((await protocol()).slice(-10))); const page = browser?.contexts().at(-1)?.pages().at(-1); if (page) { console.error('Sidebar:', await page.locator('#sidebar').innerText().catch(() => 'unavailable')); console.error('UI state:', await page.evaluate(() => ({ sidebar: document.querySelector('#sidebar').className, active: globalThis.__codexWebuiDebug.state.active?.id, activeStatus: globalThis.__codexWebuiDebug.state.active?.status, modal: !!document.querySelector('dialog[open]'), groups: [...document.querySelectorAll('.sidebar-project-row')].map(n => [n.textContent, n.getAttribute('aria-expanded')]) }))); await page.screenshot({ path: artifact('thread-management-failure.png') }); } throw error; } finally { if (browser) await browser.close(); server.kill(); await server.exited; await rm(temporary, { recursive: true, force: true }); }
