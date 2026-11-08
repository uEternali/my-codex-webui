import { createServer } from 'node:net';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';
import { artifact, launchOptions, root } from './browser-runtime.mjs';

const assert = (value, message) => { if (!value) throw Error(message); };
const temporary = await mkdtemp(join(homedir(), '.webui-projects-navigation-'));
const bin = join(temporary, 'bin'), home = join(temporary, 'codex'), log = join(temporary, 'rpc.jsonl'), control = join(temporary, 'control.json');
await mkdir(bin); await mkdir(home); await writeFile(log, '');
const projects = [];
for (const transport of ['ws', 'sse']) for (const [name, count, archivedCount] of [['alpha', 121, 3], ['beta', 2, 0]]) {
  const cwd = join(temporary, `${name}-${transport}`); await mkdir(cwd); await writeFile(join(cwd, 'keep.txt'), 'Keep workspace files');
  projects.push({ prefix: `${name}-${transport}`, cwd, count, archivedCount });
}
for (const transport of ['ws', 'sse']) {
  const source = `relations-${transport}-0`, agent = `agents-${transport}-0`;
  for (const [prefix, threads] of [
    [`relations-${transport}`, [{}]],
    [`branches-${transport}`, [{ forkedFromId: source }, { forkedFromId: `branches-${transport}-0` }]],
    [`agents-${transport}`, [{ parentThreadId: source }, { parentThreadId: agent }]],
  ]) {
    const cwd = join(temporary, prefix); await mkdir(cwd);
    projects.push({ prefix, cwd, count: threads.length, archivedCount: 0, threads });
  }
}
let settings = { finish: 0, projects };
const configure = async changes => { Object.assign(settings, changes); await writeFile(control + '.next', JSON.stringify(settings)); await rename(control + '.next', control); };
await configure({}); await copyFile(join(root, 'tests/fixtures/thread-actions-codex.mjs'), join(bin, 'codex')); await chmod(join(bin, 'codex'), 0o700);
const port = await new Promise(resolve => { const probe = createServer(); probe.listen(0, '127.0.0.1', () => { const value = probe.address().port; probe.close(() => resolve(value)); }); });
const base = `http://127.0.0.1:${port}`;
const server = Bun.spawn([process.execPath, 'run', 'server.ts'], { cwd: root, env: { ...process.env, PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH}`, HOST: '127.0.0.1', PORT: String(port), CODEX_HOME: home, CODEX_WEBUI_CWD: temporary, CODEX_WEBUI_AUTH_STORE: join(temporary, 'auth.json'), CODEX_WEBUI_PASSWORD: '', CODEX_WEBUI_ACCESS_TOKEN: '', ACTION_FIXTURE_LOG: log, ACTION_FIXTURE_CONTROL: control }, stdout: 'ignore', stderr: 'inherit' });
const protocol = async () => (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
const rpc = async (method, params) => {
  const result = await fetch(base + '/api/rpc', { method: 'POST', headers: { 'content-type': 'application/json', Origin: base }, body: JSON.stringify({ id: 900, method, params }) }).then(response => response.json());
  if (result.type !== 'rpc/result') throw Error(result.error); return result.result;
};
const allThreads = async archived => {
  const result = []; let cursor;
  do { const page = await rpc('thread/list', { archived, limit: 100, searchTerm: '', ...(cursor ? { cursor } : {}) }); result.push(...page.data); cursor = page.nextCursor; } while (cursor);
  return result;
};
let browser, page, phase = 'startup'; const errors = [], results = [];
try {
  const deadline = Date.now() + 15000;
  while (true) { try { if ((await fetch(base + '/api/health').then(r => r.json())).codex) break; } catch {} if (Date.now() > deadline) throw Error('Fixture startup timeout'); await Bun.sleep(40); }
  browser = await chromium.launch(launchOptions());
  for (const transport of ['ws', 'sse']) {
    const context = await browser.newContext({ viewport: { width: 1120, height: 850 } });
    await context.addInitScript(() => {
      if (window !== window.top) return;
      localStorage.setItem('codex-webui-locale', 'en');
      // Stale shared preferences from earlier WebUI versions must be ignored.
      localStorage.setItem('codex-webui-active-thread', 'parent-ws'); localStorage.setItem('codex-webui-project', '/old/global-project');
    });
    const newPage = async route => {
      const target = await context.newPage(); target.setDefaultTimeout(12000); target.on('pageerror', error => errors.push(error.message));
      if (transport === 'sse') await target.routeWebSocket('**/ws', socket => socket.close());
      await target.goto(base + route); await ready(target); return target;
    };
    const ready = target => target.waitForFunction(() => globalThis.__codexWebuiDebug?.state.connected && !globalThis.__codexWebuiDebug.state.initializing);
    const selected = target => target.evaluate(() => globalThis.__codexWebuiDebug.state.active?.id || null);
    const alpha = projects.find(project => project.prefix === `alpha-${transport}`), beta = projects.find(project => project.prefix === `beta-${transport}`);
    const group = project => page.locator(`.sidebar-project-group[data-project="${project.cwd}"]`);
    const more = async project => { await group(project).locator('.sidebar-project-toolbar').hover(); await group(project).locator('.project-more').click(); await page.locator('#projectActionsMenu').waitFor(); };
    const chooseAction = async (project, action, accept = true) => {
      await more(project); const dialog = page.waitForEvent('dialog');
      await page.locator(`[data-project-action="${action}"]`).click();
      const confirmation = await dialog; const message = confirmation.message();
      if (accept) await confirmation.accept(); else await confirmation.dismiss(); return message;
    };

    phase = transport + ': independent windows';
    page = await newPage('/?thread=parent-ws'); const second = await newPage('/?thread=parent-sse');
    assert(await selected(page) === 'parent-ws' && await selected(second) === 'parent-sse', 'Each URL opens its own session');
    await page.reload(); await ready(page); await second.reload(); await ready(second);
    assert(await selected(page) === 'parent-ws' && await selected(second) === 'parent-sse', 'Refreshing two windows sharing localStorage preserves their independent sessions');
    const fresh = await newPage('/');
    assert(await selected(fresh) === null && await fresh.locator('#composerProjectLabel').textContent() === 'Choose project', 'Bare URL opens a blank, unselected workspace');
    assert(await fresh.locator('#projectPath').textContent() === '', 'Bare URL does not inherit the global project or the server default');
    const beforeSend = (await protocol()).filter(call => ['thread/start', 'turn/start'].includes(call.method)).length;
    await fresh.locator('#prompt').fill('Preserve this unsent draft'); await fresh.locator('#prompt').press('Enter');
    await fresh.locator('#folderDialog[open]').waitFor();
    assert((await protocol()).filter(call => ['thread/start', 'turn/start'].includes(call.method)).length === beforeSend, 'An unselected chat cannot silently create a session in an unrelated workspace');
    await fresh.locator('#projectlessOption').click();
    assert(await fresh.locator('#prompt').inputValue() === 'Preserve this unsent draft', 'Choosing None preserves the unsent draft');
    await fresh.locator('#prompt').press('Enter'); await fresh.waitForFunction(() => !!document.querySelector('#sendButton').dataset.turnId);
    assert(new URL(fresh.url()).searchParams.get('thread') === await selected(fresh), 'Newly created sessions get a reloadable URL');
    await fresh.locator('#prompt').press('Escape'); await fresh.waitForFunction(() => !document.querySelector('#sendButton').dataset.turnId);
    await fresh.locator('#newTask').click();
    assert(await selected(fresh) === null && new URL(fresh.url()).search === '' && await fresh.locator('#composerProjectLabel').textContent() === 'Choose project', 'Global new chat clears both session and workspace selection');
    await fresh.close(); await second.close();

    phase = transport + ': history and settings';
    await page.evaluate(() => globalThis.__codexWebuiDebug.openThread('parent-sse'));
    await page.goBack(); await page.waitForFunction(() => globalThis.__codexWebuiDebug.state.active?.id === 'parent-ws' && !globalThis.__codexWebuiDebug.state.threadLoading);
    await page.goForward(); await page.waitForFunction(() => globalThis.__codexWebuiDebug.state.active?.id === 'parent-sse' && !globalThis.__codexWebuiDebug.state.threadLoading);
    await page.locator('#accountButton').click();
    assert(new URL(page.url()).pathname === '/settings/general-settings' && new URL(page.url()).searchParams.get('thread') === 'parent-sse', 'Settings retain the current session in the URL');
    await page.reload(); await ready(page); await page.locator('#settingsDialog[open]').waitFor();
    assert(await selected(page) === 'parent-sse', 'Refreshing settings restores the underlying session');
    await page.locator('#closeSettingsNav').click(); await page.locator('#settingsDialog').waitFor({ state: 'hidden' });
    assert(new URL(page.url()).searchParams.get('thread') === 'parent-sse', 'Closing settings returns to the same conversation');
    await configure({ readDelay: { 'parent-ws': 400 } });
    const race = await page.evaluate(async () => { const api = globalThis.__codexWebuiDebug; await Promise.all([api.openThread('parent-ws'), api.openThread('parent-sse')]); return api.state.active.id; });
    assert(race === 'parent-sse', 'An older delayed read cannot overwrite a newer navigation'); await configure({ readDelay: {} });

    phase = transport + ': project toolbar';
    await more(alpha);
    assert(await page.locator('#projectActionsMenu [role="menuitem"] svg').count() === 2, 'Every project menu action has an icon');
    const geometry = await page.locator('#projectActionsMenu').boundingBox();
    assert(geometry.x >= 0 && geometry.y >= 0 && geometry.x + geometry.width <= 1120 && geometry.y + geometry.height <= 850, 'Project menu is portalled inside the viewport');
    await page.locator('#threadTitle').click(); assert(await page.locator('#projectActionsMenu').isHidden(), 'Outside click closes project menu');
    await group(alpha).locator('.sidebar-project-toolbar').hover(); await group(alpha).locator('.project-new-chat').click();
    assert(await selected(page) === null && await page.evaluate(() => globalThis.__codexWebuiDebug.state.workspaceContext?.cwd) === alpha.cwd, 'Project compose creates a blank chat with that project explicitly selected');
    await page.reload(); await ready(page);
    assert(await selected(page) === null && await page.evaluate(() => globalThis.__codexWebuiDebug.state.workspaceContext?.cwd) === alpha.cwd, 'Refreshing a project draft preserves only that window’s selection');
    await page.locator('#prompt').fill('Keep folder draft'); await page.locator('#composerProjectButton').click(); await page.locator('#folderConfirm:not(:disabled)').waitFor(); await page.locator('#folderConfirm').click();
    assert(await page.locator('#prompt').inputValue() === 'Keep folder draft', 'Choosing a workspace preserves the draft');
    await page.locator('#newTask').click();

    phase = transport + ': running and pagination checks';
    await rpc('host/thread/pin', { threadId: `${alpha.prefix}-0`, pinned: true });
    const archiveBefore = (await protocol()).filter(call => call.method === 'thread/archive').length;
    await configure({ runningIds: [`${alpha.prefix}-120`] });
    await more(alpha); await page.locator('[data-project-action="archive"]').click();
    await page.locator('#toast').getByText('Stop running tasks in this project first', { exact: true }).waitFor();
    assert((await protocol()).filter(call => call.method === 'thread/archive').length === archiveBefore, 'A running task outside the visible first page blocks a project archive');
    await configure({ runningIds: [], repeatCursor: true });
    await more(alpha); await page.locator('[data-project-action="archive"]').click();
    await page.locator('#toast').getByText('Could not archive project (0/0): Could not load the complete chat list', { exact: true }).waitFor();
    assert((await protocol()).filter(call => call.method === 'thread/archive').length === archiveBefore, 'Invalid pagination fails closed before any mutation'); await configure({ repeatCursor: false });
    const cancelMessage = await chooseAction(alpha, 'archive', false);
    assert(cancelMessage.includes('121 chats') && cancelMessage.includes('files will be kept'), 'Confirmation includes all pages and preserves workspace files');
    await page.locator('#toast').getByText('Canceled', { exact: true }).waitFor();
    assert((await protocol()).filter(call => call.method === 'thread/archive').length === archiveBefore, 'Canceling batch archive performs no mutation');

    phase = transport + ': archive, restore, delete';
    await chooseAction(alpha, 'archive');
    await page.locator('#toast').getByText('Project archived (121 chats)', { exact: true }).waitFor();
    assert(!(await allThreads(false)).some(thread => thread.cwd === alpha.cwd), 'Project archive covers every page');
    assert((await allThreads(true)).filter(thread => thread.cwd === alpha.cwd).length === 124, 'Previously archived sessions are preserved');
    await group(alpha).waitFor({ state: 'detached' });
    await page.locator('#archiveThreadsButton').click();
    const restoredId = `${alpha.prefix}-0`, archivedRow = page.locator(`#archivedThreadList .thread-item[data-id="${restoredId}"]`);
    while (!await archivedRow.count()) { const more = page.locator('#archivedThreadList .archive-load-more').filter({ hasText: 'Load more' }); await more.click(); await page.waitForFunction(id => document.querySelector(`#archivedThreadList .thread-item[data-id="${id}"]`) || !document.querySelector('#archivedThreadList .archive-list-state'), restoredId); }
    await archivedRow.hover(); await archivedRow.locator('.thread-restore').click();
    await group(alpha).locator(`.thread-item[data-id="${restoredId}"]`).waitFor();
    const restored = (await rpc('thread/read', { threadId: restoredId })).thread;
    assert(restored.cwd === alpha.cwd && !restored.projectless, 'Restoring recreates the original project without changing its workspace');
    const deleteMessage = await chooseAction(alpha, 'delete');
    assert(deleteMessage.includes('124 chats') && deleteMessage.includes('including archived chats and agent sub-tasks'), 'Project deletion includes archived sessions and names its scope');
    await page.locator('#toast').getByText('Project deleted (124 chats)', { exact: true }).waitFor();
    assert(![...await allThreads(false), ...await allThreads(true)].some(thread => thread.cwd === alpha.cwd), 'Permanent deletion removes all project sessions, including archives');
    assert((await allThreads(false)).filter(thread => thread.cwd === beta.cwd).length === 2, 'Other projects remain intact');
    assert(await readFile(join(alpha.cwd, 'keep.txt'), 'utf8') === 'Keep workspace files', 'Archive and delete never remove workspace files');

    phase = transport + ': independent forks and spawned agents';
    const sourceProject = projects.find(project => project.prefix === `relations-${transport}`);
    const agents = [`agents-${transport}-0`, `agents-${transport}-1`], forks = [`branches-${transport}-0`, `branches-${transport}-1`];
    await configure({ runningIds: [agents[1]] });
    await more(sourceProject); await page.locator('[data-project-action="delete"]').click();
    await page.locator('#toast').getByText('Stop running tasks in this project first', { exact: true }).waitFor();
    await configure({ runningIds: forks });
    await page.reload(); await ready(page);
    const scopedMessage = await chooseAction(sourceProject, 'delete');
    assert(scopedMessage.includes('3 chats') && scopedMessage.includes('independent branches in other projects will be kept'), 'Deletion counts spawned agents, while running independent forks do not block it');
    await page.locator('#toast').getByText('Project deleted (3 chats)', { exact: true }).waitFor();
    const survivors = [...await allThreads(false), ...await allThreads(true)].map(thread => thread.id);
    assert(forks.every(id => survivors.includes(id)) && agents.every(id => !survivors.includes(id)), 'Deleting a source project preserves ordinary forks in another project and removes spawned descendants');
    await configure({ runningIds: [] });

    phase = transport + ': partial failure';
    await configure({ archiveRejectId: `${beta.prefix}-0` });
    await chooseAction(beta, 'archive');
    await page.locator('#toast').getByText('Could not archive project (1/2): HTTP 503: archive service unavailable', { exact: true }).waitFor();
    assert((await allThreads(false)).filter(thread => thread.cwd === beta.cwd).length === 1 && (await allThreads(true)).filter(thread => thread.cwd === beta.cwd).length === 1, 'A partial batch failure reports actual progress and keeps the remainder recoverable');
    await configure({ archiveRejectId: null });
    assert(await readFile(join(beta.cwd, 'keep.txt'), 'utf8') === 'Keep workspace files', 'Failed batches also preserve workspace files');
    await page.setViewportSize({ width: 390, height: 844 }); await page.waitForFunction(() => innerWidth === 390 && !document.querySelector('#sidebar').classList.contains('mobile-open')); await page.locator('#toggleSidebar').click(); await page.locator('#sidebar.mobile-open').waitFor(); await group(beta).locator('.project-more').click();
    const mobile = await page.locator('#projectActionsMenu').boundingBox();
    assert(mobile.x >= 0 && mobile.x + mobile.width <= 390, 'Project actions remain usable on mobile');
    await page.screenshot({ path: artifact(`project-menu-${transport}.png`) });
    await page.locator('[data-project-action="archive"]').press('Escape');
    assert(await page.locator('#projectActionsMenu').isHidden(), 'Escape closes project menu');
    await page.goto(base + '/?thread=missing'); await ready(page);
    assert(await selected(page) === null && new URL(page.url()).search === '', 'A removed or invalid session URL returns to a fresh blank chat');
    results.push({ transport, independentWindows: true, explicitWorkspace: true, settings: true, completeBatchCounts: [121, 124], restoreOriginalWorkspace: true, independentForks: true, spawnedAgents: true, protectedRunningTask: true, partialFailure: true, mobile: true });
    await context.close();
  }
  assert(!errors.length, `Browser errors: ${errors.join('; ')}`); console.log(JSON.stringify({ results, errors }, null, 2));
} catch (error) {
  console.error('Phase:', phase, 'Browser errors:', errors, error); console.error('Recent RPC:', JSON.stringify((await protocol()).slice(-8)));
  if (page) { console.error('State:', await page.evaluate(() => ({ url: location.href, active: globalThis.__codexWebuiDebug?.state.active?.id, toast: document.querySelector('#toast').textContent })).catch(() => null)); await page.screenshot({ path: artifact('projects-navigation-failure.png'), timeout: 2000 }).catch(() => {}); }
  throw error;
} finally { if (browser) await browser.close(); server.kill(); await server.exited; await rm(temporary, { recursive: true, force: true }); }
