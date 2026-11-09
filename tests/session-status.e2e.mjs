import { createServer } from 'node:net';
import { appendFileSync, chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { chromium, webkit } from 'playwright';
import { artifact, launchOptions, root } from './browser-runtime.mjs';

const assert = (value, message) => { if (!value) throw Error(message); };
const temporary = mkdtempSync(join(homedir(), '.webui-session-status-'));
for (const name of ['bin', 'codex/sessions', 'workspace']) mkdirSync(join(temporary, name), { recursive: true });
const cwd = join(temporary, 'workspace'), control = join(temporary, 'control.json'), log = join(temporary, 'rpc.jsonl'), rollout = join(temporary, 'codex/sessions/status.jsonl');
spawnSync('git', ['init', '--initial-branch=status-dev', cwd], { stdio: 'ignore' });
const settings = { models: [{ id: 'gpt-fixture', model: 'gpt-fixture', displayName: 'GPT-Fixture', isDefault: true, defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] }], projects: [{ prefix: 'status', cwd, count: 2, threads: [{ sessionId: 'status-0', path: rollout }, { sessionId: 'status-1', forkedFromId: 'status-0' }] }, { prefix: 'agents', cwd, count: 3, threads: [
  { sessionId: 'agents-0', parentThreadId: 'status-0', source: 'subAgentThreadSpawn', agentNickname: 'Curie', status: { type: 'active' }, turns: Array.from({ length: 23 }, (_, index) => ({ id: `child-turn-${index}`, status: 'completed', items: [{ id: `child-answer-${index}`, type: 'agentMessage', text: `Child result ${index}` }] })) },
  { sessionId: 'agents-1', parentThreadId: 'agents-0', source: {subAgent:{thread_spawn:{parent_thread_id:'agents-0'}}}, agentNickname: 'Newton', turns: [{ id: 'nested-turn', status: 'completed', items: [{ id: 'nested-answer', type: 'agentMessage', text: 'Nested child result' }] }] },
  { sessionId: 'other-session', parentThreadId: 'other-parent', source: 'subAgentThreadSpawn', agentNickname: 'Unrelated' },
] }] };
writeFileSync(control, JSON.stringify(settings));
const tokenEvent = (used, total) => JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: {
  model_context_window: 100000, last_token_usage: { input_tokens: used - 100, output_tokens: 100, total_tokens: used },
  total_token_usage: { input_tokens: total - 1000, cached_input_tokens: 1000, output_tokens: 1000, reasoning_output_tokens: 200, total_tokens: total },
} } }) + '\n';
copyFileSync(join(root, 'tests/fixtures/thread-actions-codex.mjs'), join(temporary, 'bin/codex')); chmodSync(join(temporary, 'bin/codex'), 0o700);
const port = await new Promise(resolve => { const probe = createServer(); probe.listen(0, '127.0.0.1', () => { const port = probe.address().port; probe.close(() => resolve(port)); }); });
const base = `http://127.0.0.1:${port}`;
const server = Bun.spawn([process.execPath, 'run', 'server.ts'], { cwd: root, env: { ...process.env,
  PATH: `${join(temporary, 'bin')}:${dirname(process.execPath)}:${process.env.PATH}`, HOST: '127.0.0.1', PORT: String(port), CODEX_HOME: join(temporary, 'codex'), CODEX_WEBUI_CWD: cwd, CODEX_WEBUI_AUTH_STORE: join(temporary, 'auth.json'), CODEX_WEBUI_PASSWORD: '', CODEX_WEBUI_ACCESS_TOKEN: '', ACTION_FIXTURE_CONTROL: control, ACTION_FIXTURE_LOG: log,
}, stdout: 'ignore', stderr: 'inherit' });
const ready = page => page.waitForFunction(() => globalThis.__codexWebuiDebug?.state.connected && !globalThis.__codexWebuiDebug.state.initializing && !globalThis.__codexWebuiDebug.state.threadLoading);
let browser, page, phase = 'startup'; const errors = [], results = [];
try {
  const deadline = Date.now() + 10000;
  while (true) { try { if ((await fetch(base + '/api/health').then(r => r.json())).codex) break; } catch {} if (Date.now() > deadline) throw Error('Fixture did not start'); await Bun.sleep(30); }
  browser = process.env.PLAYWRIGHT_BROWSER === 'webkit' ? await webkit.launch({ headless: true }) : await chromium.launch(launchOptions());
  for (const transport of ['ws', 'sse']) {
    writeFileSync(rollout, tokenEvent(65000, 300000));
    const context = await browser.newContext({ viewport: { width: 1280, height: 850 }, colorScheme: 'light' });
    await context.addInitScript(() => {
      if (window !== window.top) return;
      localStorage.setItem('codex-webui-locale', 'en');
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.__statusCopied = text; } } });
    });
    page = await context.newPage(); page.setDefaultTimeout(8000); page.on('pageerror', error => errors.push(error.message));
    if (transport === 'sse') await page.routeWebSocket('**/ws', socket => socket.close());
    phase = transport + ': blank status';
    await page.goto(base); await ready(page);
    assert(JSON.stringify(await page.locator('.top-actions>button').evaluateAll(nodes => nodes.map(node => node.id))) === JSON.stringify(['toggleTheme', 'toggleSidebar', 'toggleBottomPanel', 'toggleSidePanel', 'toggleSummaryPanel']), 'Theme is first and information is last in the top buttons');
    await page.locator('#toggleSummaryPanel').click();
    assert(await page.locator('[data-status-copy]').count() === 0 && await page.locator('[role=progressbar]').count() === 0, 'A blank chat never fabricates an ID or 0% context use');
    assert(!(await page.locator('#summaryPanel').textContent()).includes('Computer Use'), 'Placeholder sections are removed');
    phase = transport + ': restored context and identifiers';
    await page.evaluate(() => globalThis.__codexWebuiDebug.openThread('status-0')); await ready(page);
    await page.waitForFunction(() => document.querySelector('[role=progressbar]')?.getAttribute('aria-valuenow') === '65');
    await page.waitForFunction(() => document.querySelector('#summaryBranch')?.textContent === 'status-dev');
    assert((await page.locator('#summaryWorkspace').textContent()) === cwd, 'Show the complete workspace path and actual Git branch');
    assert((await page.locator('#summaryPanel').textContent()).includes('299,000'), 'Display actual cumulative token counts separately from context use');
    assert((await page.locator('#summaryPanel').textContent()).includes('gpt-fixture'), 'Show the model actually selected in the composer');
    await page.locator('[data-status-toggle-chats]').waitFor();
    assert(await page.locator('.status-chat-primary').evaluate(node => node.children[1].hasAttribute('data-status-toggle-chats') && node.lastElementChild.hasAttribute('data-status-copy')), 'Related-chat arrow precedes the copy button');
    assert(await page.locator('[data-status-copy]').count() === 4, 'Display the native Session, selected Chat and two confirmed child IDs');
    assert((await page.locator('#summaryPanel dt').allTextContents()).slice(0, 4).join('|') === 'Session|Chat|Background information|Limits', 'Use the official status names and ordering');
    await page.locator('[data-status-toggle-chats]').click();
    assert(await page.locator('#statusRelatedChats [data-status-open-thread]').count() === 2, 'Discover nested subagents absent from the ordinary sidebar query');
    assert(!(await page.locator('#statusRelatedChats').textContent()).includes('status-1'), 'Independent forks with a new sessionId do not enter this session tree');
    await page.locator('.status-chat-primary [data-status-copy="status-0"]').click();
    assert(await page.evaluate(() => window.__statusCopied) === 'status-0', 'Copy the real selected Chat ID');
    await page.locator('#closeSummaryPanel').click(); await page.locator('#modelButton').click(); await page.locator('[data-value=high]').click(); await page.locator('#toggleSummaryPanel').click(); await page.waitForFunction(() => document.querySelector('#summaryPanel').getBoundingClientRect().width >= 300);
    assert((await page.locator('#summaryPanel').textContent()).includes('High'), 'Reasoning changes update the next-message configuration');
    const copyButton = await page.locator('.status-chat-primary [data-status-copy="status-0"]').elementHandle();
    await page.evaluate(() => globalThis.__codexWebuiDebug.notify('thread/status/changed', { threadId: 'status-0', status: { type: 'idle' } }));
    assert(await copyButton.evaluate(node => node.isConnected), 'An unchanged status render preserves controls and focus');
    await page.screenshot({ animations: 'disabled', path: artifact(`session-status-${transport}.png`) });

    phase = transport + ': notifications and stale history';
    await page.evaluate(() => {
      const debug = globalThis.__codexWebuiDebug;
      debug.notify('thread/tokenUsage/updated', { threadId: 'status-0', tokenUsage: { modelContextWindow: 100000, last: { totalTokens: 70000 }, total: { totalTokens: 500000, inputTokens: 499000, outputTokens: 1000 } } });
      debug.notify('thread/status/changed', { threadId: 'status-0', status: { type: 'active', activeFlags: ['waitingOnApproval'] } });
    });
    assert((await page.locator('#summaryPanel').textContent()).includes('Waiting for approval'), 'Runtime flags update the displayed status');
    assert(await page.locator('[data-status-toggle-chats]').getAttribute('aria-expanded') === 'true', 'Expanded related chats survive usage and state notifications');
    await page.waitForTimeout(2800);
    assert(await page.locator('[role=progressbar]').getAttribute('aria-valuenow') === '70', 'Older rollout data cannot overwrite newer native usage');
    await page.reload(); await ready(page); await page.locator('#toggleSummaryPanel').click();
    await page.waitForFunction(() => document.querySelector('[role=progressbar]')?.getAttribute('aria-valuenow') === '65');
    appendFileSync(rollout, tokenEvent(20000, 400000));
    await page.waitForFunction(() => document.querySelector('[role=progressbar]')?.getAttribute('aria-valuenow') === '20');

    phase = transport + ': navigation isolation';
    await page.evaluate(() => globalThis.__codexWebuiDebug.openThread('status-1')); await ready(page);
    assert(await page.locator('[role=progressbar]').count() === 0, 'A session without usage does not inherit another session’s data');
    assert(await page.locator('[data-status-copy]').count() === 2 && await page.locator('[data-status-toggle-chats]').count() === 0, 'An independent fork has its own Session and Chat, without children inherited from its source');
    await page.evaluate(() => globalThis.__codexWebuiDebug.notify('thread/tokenUsage/updated', { threadId: 'status-0', tokenUsage: { modelContextWindow: 100000, last: { totalTokens: 99999 } } }));
    assert(await page.locator('[role=progressbar]').count() === 0, 'Background session updates do not repaint the selected session');
    await page.evaluate(() => globalThis.__codexWebuiDebug.startNewTask());
    assert(await page.locator('[data-status-copy]').count() === 0 && await page.locator('#summaryWorkspace').textContent() === 'Choose project', 'A fresh blank chat clears session and workspace details');

    phase = transport + ': persisted subagents and inline content';
    await page.locator('#closeSummaryPanel').click();
    await page.evaluate(() => globalThis.__codexWebuiDebug.openThread('status-0')); await ready(page);
    await page.locator('#toggleSidePanel').click(); await page.locator('[data-side-panel-action="side-task"]').click();
    await page.locator('.side-task-card[data-thread-id="agents-0"]').waitFor();
    assert(await page.locator('.side-task-card').count() === 2, 'Restore direct and nested children from native metadata without loading their spawn message');
    assert(await page.locator('#threadList .thread-item[data-thread-id^="agents-"]').count() === 0, 'Subagents do not become unrelated top-level project chats');
    await page.locator('.side-task-card[data-thread-id="agents-0"]').click();
    await page.locator('[data-subagent-content]').getByText('Child result 22', { exact: true }).waitFor();
    assert(await page.evaluate(() => globalThis.__codexWebuiDebug.state.active.id) === 'status-0', 'Viewing a child in the side pane preserves the main chat and route');
    await page.locator('[data-subagent-earlier]').click();
    await page.locator('[data-subagent-content]').getByText('Child result 0', { exact: true }).waitFor();
    await page.locator('#backSideTasks').click(); await page.locator('.side-task-card[data-thread-id="agents-1"]').click();
    await page.locator('[data-subagent-content]').getByText('Nested child result', { exact: true }).waitFor();
    await page.screenshot({ animations: 'disabled', path: artifact(`subagent-preview-${transport}.png`) });
    await page.reload(); await ready(page); await page.locator('#toggleSidePanel').click(); await page.locator('[data-side-panel-action="side-task"]').click();
    await page.locator('.side-task-card[data-thread-id="agents-0"]').waitFor();
    assert(await page.locator('.side-task-card').count() === 2, 'Refreshing restores the persisted subagent list');
    settings.readDelay = { 'agents-0': 900 }; writeFileSync(control, JSON.stringify(settings));
    await page.locator('.side-task-card[data-thread-id="agents-0"]').click();
    await page.locator('#backSideTasks').click(); await page.locator('.side-task-card[data-thread-id="agents-1"]').click();
    await page.locator('[data-subagent-content]').getByText('Nested child result', { exact: true }).waitFor();
    await page.waitForTimeout(1000);
    assert(await page.locator('[data-subagent-id]').textContent() === 'agents-1' && !(await page.locator('[data-subagent-content]').textContent()).includes('Child result 22'), 'Late child reads cannot overwrite a different preview');
    settings.readDelay = {}; settings.readRejectId = 'agents-0'; writeFileSync(control, JSON.stringify(settings));
    await page.locator('#backSideTasks').click(); await page.locator('.side-task-card[data-thread-id="agents-0"]').click();
    await page.locator('[data-subagent-notice]').getByText('HTTP 503: subagent history unavailable', { exact: true }).waitFor();
    assert(await page.evaluate(() => globalThis.__codexWebuiDebug.state.active.id) === 'status-0', 'A child history failure does not move or interrupt the main chat');
    delete settings.readRejectId; writeFileSync(control, JSON.stringify(settings));
    await page.locator('[data-subagent-retry]').click(); await page.locator('[data-subagent-content]').getByText('Child result 22', { exact: true }).waitFor();
    await page.locator('#closeSidePanel').click(); await page.locator('#toggleSummaryPanel').click();

    phase = transport + ': mobile and language';
    await page.setViewportSize({ width: 390, height: 650 });
    await page.locator('#closeSummaryPanel').click();
    await page.evaluate(() => globalThis.__codexWebuiDebug.openThread('status-0')); await ready(page);
    await page.locator('#toggleSummaryPanel').click();
    await page.waitForFunction(() => document.activeElement?.id === 'closeSummaryPanel');
    const geometry = await page.locator('.summary-panel-scroll').evaluate(node => { node.scrollTop = node.scrollHeight; return { width: node.clientWidth, full: node.scrollWidth, bottom: node.getBoundingClientRect().bottom, last: node.lastElementChild.getBoundingClientRect().bottom }; });
    assert(geometry.full <= geometry.width + 1 && geometry.last <= geometry.bottom + 1, 'Long identifiers fit a mobile panel and its last section stays reachable');
    await page.evaluate(() => globalThis.__codexWebuiI18n.setPreference('zh-CN'));
    assert((await page.locator('#summaryPanel').textContent()).includes('运行配置'), 'Status content follows language changes');
    await page.screenshot({ animations: 'disabled', path: artifact(`session-status-mobile-${transport}.png`) });
    await page.keyboard.press('Escape'); await page.locator('#summaryPanel').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.activeElement?.id === 'toggleSummaryPanel');
    results.push({ transport, geometry });
    await context.close();
  }
  const calls = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  assert(!calls.some(call => ['thread/resume', 'turn/start'].includes(call.method)), 'Viewing status never acquires session ownership or starts model work');
  assert(!errors.length, 'No browser errors: ' + errors.join('; '));
  console.log(JSON.stringify({ results, errors }, null, 2));
} catch (error) {
  if (page) console.error(await page.evaluate(() => ({hidden:document.querySelector('#summaryPanel').hidden,width:document.querySelector('#summaryPanel').getBoundingClientRect().width,classes:document.body.className,active:document.activeElement?.id})).catch(()=>({})));
  if (page) await page.screenshot({ animations: 'disabled', path: artifact('session-status-failure.png') }).catch(() => {});
  throw new Error(`${phase}: ${error.message}`, { cause: error });
} finally {
  await browser?.close(); server.kill(); await server.exited; rmSync(temporary, { recursive: true, force: true });
}
