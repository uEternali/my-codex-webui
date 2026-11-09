import { createServer } from 'node:net';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { chromium, webkit } from 'playwright';
import { artifact, launchOptions, root } from './browser-runtime.mjs';

const assert = (value, message) => { if (!value) throw Error(message); };
const temporary = mkdtempSync(join(homedir(), '.webui-side-panel-')), control = join(temporary, 'control.json'), log = join(temporary, 'rpc.jsonl');
for (const dir of ['bin', 'codex', 'project']) mkdirSync(join(temporary, dir));
const cwd = join(temporary, 'project');
const settings = { projects: [{ prefix: 'root', cwd, count: 1, threads: [{ sessionId: 'root-0' }] }, { prefix: 'child', cwd, count: 2, threads: [
  { sessionId: 'child-0', parentThreadId: 'root-0', agentNickname: 'Curie', source: { subAgent: { thread_spawn: { parent_thread_id: 'root-0' } } }, turns: [{ id: 'child-turn', status: 'inProgress', items: [{ id: 'child-tool', type: 'commandExecution', command: 'echo child', status: 'inProgress' }] }] },
  { sessionId: 'child-1', parentThreadId: 'child-0', agentNickname: 'Newton', source: { subAgent: { thread_spawn: { parent_thread_id: 'child-0' } } }, turns: [{ id: 'child-patch-turn', status: 'inProgress', items: [{ id: 'child-patch', type: 'fileChange', status: 'inProgress', changes: [{ path: cwd + '/child.ts', kind: 'update', diff: '@@ -1 +1 @@\n-old\n+reviewed child change' }] }] }] },
] }, { prefix: 'foreign', cwd, count: 1, threads: [{ sessionId: 'foreign-0' }] }] };
const update = () => writeFileSync(control, JSON.stringify(settings)); update();
copyFileSync(join(root, 'tests/fixtures/thread-actions-codex.mjs'), join(temporary, 'bin/codex')); chmodSync(join(temporary, 'bin/codex'), 0o700);
const port = await new Promise(resolve => { const probe = createServer(); probe.listen(0, '127.0.0.1', () => { const port = probe.address().port; probe.close(() => resolve(port)); }); });
const base = `http://127.0.0.1:${port}`;
const server = Bun.spawn([process.execPath, 'run', 'server.ts'], { cwd: root, env: { ...process.env, PATH: `${join(temporary, 'bin')}:${dirname(process.execPath)}:${process.env.PATH}`, HOST: '127.0.0.1', PORT: String(port), CODEX_HOME: join(temporary, 'codex'), CODEX_WEBUI_CWD: cwd, CODEX_WEBUI_AUTH_STORE: join(temporary, 'auth.json'), CODEX_WEBUI_PASSWORD: '', CODEX_WEBUI_ACCESS_TOKEN: '', ACTION_FIXTURE_CONTROL: control, ACTION_FIXTURE_LOG: log }, stdout: 'ignore', stderr: 'inherit' });
const ready = page => page.waitForFunction(() => globalThis.__codexWebuiDebug?.state.connected && !globalThis.__codexWebuiDebug.state.initializing && !globalThis.__codexWebuiDebug.state.threadLoading);
const calls = () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const approval = (id, threadId, kind = 'commandExecution') => ({ id, method: `item/${kind}/requestApproval`, params: { threadId, turnId: 'child-turn', itemId: 'child-tool', command: 'echo child', cwd, reason: 'Isolated approval test. No command is executed.', permissions: { network: { enabled: true } } } });
let browser, page, phase = 'startup'; const errors = [], reports = [];
try {
  const deadline = Date.now() + 10000;
  while (true) { try { if ((await fetch(base + '/api/health').then(r => r.json())).codex) break; } catch {} if (Date.now() > deadline) throw Error('Fixture did not start'); await Bun.sleep(30); }
  browser = process.env.PLAYWRIGHT_BROWSER === 'webkit' ? await webkit.launch({ headless: true }) : await chromium.launch(launchOptions());
  for (const transport of ['ws', 'sse']) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
    await context.addInitScript(() => { if (window === window.top) localStorage.setItem('codex-webui-locale', 'en'); });
    page = await context.newPage(); page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
    if (transport === 'sse') await page.routeWebSocket('**/ws', socket => socket.close());
    await page.goto(base + '/?thread=root-0'); await ready(page);
    phase = transport + ': chooser and terminals';
    await page.locator('#toggleSidePanel').click();
    const firstId = await page.locator('#sidePanelTabs [role=tab]').getAttribute('id');
    await page.locator('[data-side-panel-action=terminal]').click();
    assert(await page.locator('#sidePanelTabs [role=tab]').count() === 1 && await page.locator('#sidePanelTabs [role=tab]').getAttribute('id') === firstId, 'Choosing a feature converts its chooser without adding a tab');
    await page.locator('#sideTerminalHost[data-connected=true]').waitFor();
    async function command(text) { await page.locator('#sideTerminalPanel>.terminal-host:not([hidden]) .xterm-helper-textarea').focus(); await page.keyboard.type(text); await page.keyboard.press('Enter'); }
    const output = expected => page.waitForFunction(expected => { const term = globalThis.__codexTerminals?.side?.term; return term && Array.from({ length: term.buffer.active.length }, (_, i) => term.buffer.active.getLine(i)?.translateToString(true)).join('').includes(expected); }, expected);
    await command("export SIDE_TAB_VALUE=first; printf '\\nSIDE_CWD=%s\\n' \"$PWD\""); await output(`SIDE_CWD=${cwd}`);
    await page.locator('#openSidePanelTab').click(); await page.locator('[data-side-panel-action=terminal]').click();
    await page.waitForFunction(() => globalThis.__codexWebuiDebug.sideTabs.active.terminal.ws?.readyState === 1);
    await command("printf '\\nSIDE_VALUE=%s\\n' \"${SIDE_TAB_VALUE-unset}\""); await output('SIDE_VALUE=unset');
    const secondId = await page.locator('#sidePanelTabs [role=tab][aria-selected=true]').getAttribute('id');
    await page.locator('#' + firstId).click(); await command("printf '\\nFIRST_VALUE=%s\\n' \"$SIDE_TAB_VALUE\""); await output('FIRST_VALUE=first');
    phase = transport + ': launcher restrictions';
    await page.locator('#openSidePanelTab').click();
    assert(await page.locator('[data-side-panel-action=browser]').count() === 0, 'The launcher has no Browser entry');
    assert(await page.locator('[data-side-panel-action=terminal]').isVisible(), 'Terminal remains available with multiple open terminals');
    await page.locator('[data-side-panel-action=side-task]').click();
    const subagentId = await page.locator('#sidePanelTabs [aria-selected=true]').getAttribute('id');
    await page.locator('#openSidePanelTab').click();
    assert(!await page.locator('[data-side-panel-action=side-task]').isVisible(), 'Subagents is hidden while its tab exists');
    assert(await page.locator('[data-side-panel-action=terminal]').isVisible(), 'Subagent restrictions do not hide Terminal');
    await page.locator(`[data-close-side-tab="${subagentId}"]`).click();
    assert(await page.locator('[data-side-panel-action=side-task]').isVisible(), 'Closing the inactive Subagents tab restores its entry');
    await page.locator('[data-side-panel-action=side-task]').click();
    assert(await page.locator('#sidePanelTabs [data-side-panel-tab=side-task]').count() === 1, 'Subagents can be reopened without duplication');
    await page.locator('#openSidePanelTab').click();
    await page.locator(`[data-close-side-tab="${firstId}"]`).click();
    await page.locator('#' + secondId).click(); await command("printf '\\nSURVIVING_TERMINAL\\n'"); await output('SURVIVING_TERMINAL');
    phase = transport + ': resizing';
    const handle = page.locator('#sidePanel>[data-right-panel-resizer]'), initial = await page.locator('#sidePanel').boundingBox();
    const boundary = await handle.boundingBox(); await page.mouse.move(boundary.x + 2, boundary.y + 100); await page.mouse.down();
    for (const delta of [40, 80, 120, 160, 120, 160]) {
      await page.mouse.move(boundary.x + 2 - delta, boundary.y + 100);
      const live = await page.locator('#sidePanel').evaluate(el => { const r=el.getBoundingClientRect();return {right:r.right,width:r.width}; });
      assert(Math.abs(live.right - initial.x - initial.width) < 1, 'The right edge remains anchored during each drag step');
      assert(Math.abs(live.width - initial.width - delta) < 2, 'The left edge follows the pointer without grid animation lag');
    }
    await page.mouse.up();
    const resized = await page.locator('#sidePanel').boundingBox(); assert(Math.abs(resized.width - initial.width - 160) < 3, 'Dragging the left edge adjusts the side panel width');
    await page.waitForTimeout(350);
    assert(Math.abs((await page.locator('#sidePanel').boundingBox()).x - resized.x) < 1, 'Releasing the drag does not shift the panel back');
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.querySelector('.conversation-shell').getBoundingClientRect().width >= 440), 'Resizing keeps the conversation usable without horizontal overflow');
    await page.locator('#closeSidePanel').click(); await page.locator('#toggleSidePanel').click();
    assert(await page.locator('#sidePanelTabs [aria-selected=true]').getAttribute('data-side-panel-tab') === 'launcher', 'Reopening enters the feature chooser');
    await page.reload(); await ready(page); await page.locator('#toggleSidePanel').click();
    assert(Math.abs((await page.locator('#sidePanel').boundingBox()).width - resized.width) < 1, 'The preferred width survives a reload');
    phase = transport + ': native child IDs';
    await page.locator('#closeSidePanel').click(); await page.locator('#toggleSummaryPanel').click(); await page.locator('[data-status-toggle-chats]').click();
    assert(await page.locator('[data-status-open-thread]').count() === 2, 'Information includes descendants whose native session IDs differ from their parent');
    assert(Number(await page.locator('#summaryPanel>[data-right-panel-resizer]').getAttribute('aria-valuenow')) === Math.round((await page.locator('#summaryPanel').boundingBox()).width), 'Information panel resizing exposes its actual current width');
    await page.locator('#closeSummaryPanel').click();
    phase = transport + ': descendant approvals';
    const offset=transport==='ws'?7000:8000,execId=offset+1,patchId=offset+2,permissionId=offset+3,foreignId=offset+4;
    settings.approvalRequests = [approval(execId, 'child-0'), approval(patchId, 'child-1', 'fileChange'), approval(permissionId, 'child-0', 'permissions'), approval(foreignId, 'foreign-0')]; update();
    await page.locator('#subagentApprovalQueue .approval-card').nth(2).waitFor();
    assert(await page.locator('#subagentApprovalQueue .approval-card').count() === 3, 'The main chat shows direct and nested child approvals and excludes unrelated chats');
    await page.reload(); await ready(page); await page.locator('#subagentApprovalQueue .approval-card').nth(2).waitFor();
    await page.locator('#subagentApprovalQueue .approval-review-link').click();
    await page.locator('[data-subagent-content] [data-preview-item=child-patch]').waitFor();
    await page.locator('[data-subagent-content] [data-preview-item=child-patch] summary').click();
    assert((await page.locator('[data-subagent-content] [data-preview-item=child-patch] pre').textContent()).includes('+reviewed child change'), 'Child file approvals open the actual child patch without mixing main-chat changes');
    await page.locator('#subagentApprovalQueue [data-approval-thread-id=child-0] .approval-agent-label').first().click();
    await page.locator('[data-subagent-approvals] .approval-card').nth(1).waitFor();
    assert(await page.evaluate(() => globalThis.__codexWebuiDebug.state.active.id) === 'root-0', 'Previewing a child approval keeps the main chat selected');
    if (transport === 'sse') {
      await page.route('**/api/codex/respond', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'HTTP 503: approval temporarily unavailable' }) }));
      await page.locator('[data-subagent-approvals] .approval-deny').first().click();
      await page.locator('[data-subagent-approvals] [data-approval-error]').first().waitFor();
      assert(await page.locator('[data-subagent-approvals] .approval-deny').first().isEnabled(), 'A failed approval remains visible and retryable');
      assert(!calls().some(call => call.type === 'approvalResponse' && call.id === execId), 'Failed responses never reach the native callback');
      await page.unroute('**/api/codex/respond');
    }
    await page.locator('[data-subagent-approvals] .approval-deny').first().click();
    await page.waitForFunction(() => document.querySelectorAll('#subagentApprovalQueue .approval-card').length === 2);
    await page.locator('[data-subagent-approvals] .approval-primary').click();
    await page.waitForFunction(() => document.querySelectorAll('#subagentApprovalQueue .approval-card').length === 1);
    await page.locator('#subagentApprovalQueue .approval-deny').click();
    await page.locator('#subagentApprovalQueue').waitFor({ state: 'detached' });
    for (const id of [execId, patchId, permissionId]) {
      await page.waitForTimeout(30);
      assert(calls().filter(call => call.type === 'approvalResponse' && call.id === id).length === 1, 'Each child approval is sent exactly once: ' + id);
    }
    settings.resolvedApprovals = [...settings.resolvedApprovals || [], foreignId]; update();
    phase = transport + ': mobile';
    await page.setViewportSize({ width: 390, height: 750 });
    const geometry = await page.locator('#sidePanel').boundingBox();
    assert(geometry.width === 390 && geometry.x === 0, 'Mobile side panels fill the viewport');
    assert(!await handle.isVisible(), 'Mobile panels have no resize boundary');
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Mobile tabs never widen the page');
    await page.screenshot({ animations: 'disabled', path: artifact(`side-panel-mobile-${transport}.png`) });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator('#backSideTasks').click(); await page.locator('#openSidePanelTab').click();
    await page.screenshot({ animations: 'disabled', path: artifact(`side-panel-tabs-${transport}.png`) });
    reports.push({ transport, inPlaceTabs: true, independentTools: true, resized: resized.width, approvals: true, mobile: geometry.width });
    await context.close();
  }
  assert(!calls().some(call => ['thread/resume', 'turn/start'].includes(call.method)), 'Viewing and approving child requests does not start or resume a model turn');
  assert(!errors.length, errors.join('; ')); console.log(JSON.stringify({ reports, errors }, null, 2));
} catch (error) { if (page) await page.screenshot({ animations: 'disabled', path: artifact('side-panel-failure.png') }).catch(() => {}); throw Error(phase + ': ' + error.message, { cause: error }); }
finally { await browser?.close(); server.kill(); await server.exited; rmSync(temporary, { recursive: true, force: true }); }
