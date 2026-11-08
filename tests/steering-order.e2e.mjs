import { createServer } from 'node:net';
import { appendFile, chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';
import { artifact, launchOptions, root } from './browser-runtime.mjs';

const assert = (condition, message) => { if (!condition) throw new Error(message); };
const temporary = await mkdtemp(join(tmpdir(), 'webui-steering-'));
const bin = join(temporary, 'bin'), home = join(temporary, 'codex'), log = join(temporary, 'rpc.jsonl'), control = join(temporary, 'control.jsonl');
await mkdir(bin); await mkdir(home); await writeFile(log, ''); await writeFile(control, '');
await copyFile(join(root, 'tests/fixtures/steering-codex.mjs'), join(bin, 'codex')); await chmod(join(bin, 'codex'), 0o700);
const port = await new Promise(resolve => { const probe = createServer(); probe.listen(0, '127.0.0.1', () => { const port = probe.address().port; probe.close(() => resolve(port)); }); });
const base = `http://127.0.0.1:${port}`;
const server = Bun.spawn([process.execPath, 'run', 'server.ts'], { cwd: root, env: { ...process.env, PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH}`, HOST: '127.0.0.1', PORT: String(port), CODEX_HOME: home, CODEX_WEBUI_CWD: homedir(), CODEX_WEBUI_AUTH_STORE: join(temporary, 'auth.json'), CODEX_WEBUI_PASSWORD: '', CODEX_WEBUI_ACCESS_TOKEN: '', STEERING_FIXTURE_LOG: log, STEERING_FIXTURE_CONTROL: control }, stdout: 'ignore', stderr: 'inherit' });
let browser, rpcId = 0;
const rpc = async (method, params = {}) => {
  const response = await fetch(`${base}/api/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ id: ++rpcId, method, params }) });
  const value = await response.json(); if (value.type !== 'rpc/result') throw new Error(value.error); return value.result;
};
const commands = async command => appendFile(control, JSON.stringify(command) + '\n');
const protocol = async () => (await readFile(log, 'utf8')).split('\n').filter(Boolean).map(value => JSON.parse(value));
const sequence = page => page.locator('#conversation .user-message-text, #conversation .message-text').allTextContents().then(values => values.map(value => value.trim()));
const expectSequence = async (page, expected) => {
  try { await page.waitForFunction(expected => JSON.stringify([...document.querySelectorAll('#conversation .user-message-text, #conversation .message-text')].map(el => el.textContent.trim())) === JSON.stringify(expected), expected, { timeout: 12000 }); }
  catch (error) { throw new Error(`Wrong message order. Expected ${JSON.stringify(expected)}, received ${JSON.stringify(await sequence(page))}. ${error.message}`); }
};
const send = async (page, text) => { await page.locator('#prompt').fill(text); await page.locator('#prompt').press('Enter'); };
const errors = [], results = [];
try {
  const deadline = Date.now() + 15000;
  while (true) { try { if ((await fetch(base + '/api/health').then(response => response.json())).codex) break; } catch {} if (Date.now() > deadline) throw new Error('Fixture did not start'); await Bun.sleep(50); }
  browser = await chromium.launch(launchOptions());
  for (const transport of ['ws', 'sse']) {
    const context = await browser.newContext({ viewport: { width: 1150, height: 850 }, colorScheme: 'light' });
    await context.addInitScript(() => { if (window === window.top) localStorage.setItem('codex-webui-locale', 'en'); });
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    if (transport === 'sse') await page.routeWebSocket('**/ws', socket => socket.close());
    await page.goto(base); await page.locator('#emptyState h1').waitFor();
    await page.locator('#composerProjectButton').click(); await page.locator('#projectlessOption').click();
    await send(page, 'Initial request');
    await expectSequence(page, ['Initial request', 'First reply before guidance.']);
    const threadId = await page.evaluate(() => globalThis.__codexWebuiDebug.state.active.id);
    for (const text of ['Same guidance', 'Same guidance', 'Third guidance']) await send(page, text);
    await page.waitForFunction(() => document.querySelectorAll('[data-steering-state="queued"]').length === 3);
    const pendingOrder = ['Initial request', 'First reply before guidance.', 'Same guidance', 'Same guidance', 'Third guidance'];
    assert(JSON.stringify(await sequence(page)) === JSON.stringify(pendingOrder), 'Guidance must follow previous output immediately');
    const steerCalls = (await protocol()).filter(entry => entry.method === 'turn/steer' && entry.params.threadId === threadId);
    assert(new Set(steerCalls.map(entry => entry.params.clientUserMessageId)).size === 3, 'Repeated text needs distinct native message identities');
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll('[data-steering-state="queued"]').length === 3);
    await expectSequence(page, pendingOrder);
    await page.screenshot({ path: artifact(`steering-queued-${transport}.png`) });
    await commands({ type: 'consume', threadId, count: 3 });
    const committedOrder = ['Initial request', 'First reply before guidance.', 'Same guidance', 'Reply to: Same guidance', 'Same guidance', 'Reply to: Same guidance', 'Third guidance', 'Reply to: Third guidance'];
    await expectSequence(page, committedOrder);
    assert(await page.locator('[data-steering-state="queued"]').count() === 0, 'Only native receipts clear the queue status');
    assert(await page.locator('.steering-delivery').count() === 0, 'Consumed guidance must not leave a received notice');
    await page.reload(); await expectSequence(page, committedOrder);
    assert(await page.locator('.steering-delivery').count() === 0, 'Consumed guidance stays free of delivery notices after refresh');
    // Interruption can race a receipt: replay only the still-uncommitted input,
    // and never start the replacement turn before turn/completed.
    await page.waitForFunction(() => document.querySelector('#sendButton').dataset.turnId);
    await send(page, 'Consumed during interrupt'); await send(page, 'Read this immediately');
    await page.waitForFunction(() => document.querySelectorAll('[data-steering-state="queued"]').length === 2);
    await commands({ type: 'commit-on-interrupt', threadId });
    // Poll native log to avoid issuing Esc before the fixture receives control.
    await page.locator('#prompt').fill('Keep this unsent draft');
    const interruptBefore = (await protocol()).filter(entry => entry.method === 'turn/interrupt' && entry.params.threadId === threadId).length;
    await page.locator('#modelButton').click(); await page.locator('#prompt').press('Escape');
    assert((await protocol()).filter(entry => entry.method === 'turn/interrupt' && entry.params.threadId === threadId).length === interruptBefore, 'Escape closes an open menu without stopping the task');
    await page.locator('#prompt').dispatchEvent('keydown', { key: 'Escape', isComposing: true });
    assert((await protocol()).filter(entry => entry.method === 'turn/interrupt' && entry.params.threadId === threadId).length === interruptBefore, 'IME Escape must not stop a task');
    await page.locator('#prompt').press('Escape');
    await page.getByText('Resumed after interruption.', { exact: true }).waitFor();
    const logAfter = await protocol(), starts = logAfter.filter(entry => entry.method === 'turn/start' && entry.params.threadId === threadId);
    assert(starts.length === 2 && starts[1].params.input.map(part => part.text).join('\n') === 'Read this immediately', 'Esc must resend only the unconsumed guidance');
    assert(logAfter.findIndex(entry => entry.event === 'interruption-completed' && entry.threadId === threadId) < logAfter.indexOf(starts[1]), 'Native interruption must finish before resubmission');
    assert(await page.locator('#prompt').inputValue() === 'Keep this unsent draft', 'Esc preserves the current unsent draft');
    assert((await sequence(page)).filter(text => text === 'Read this immediately').length === 1, 'Resubmitted guidance must appear once');
    await page.reload();
    await page.getByText('Resumed after interruption.', { exact: true }).waitFor();
    const reloaded = await sequence(page);
    assert(reloaded.indexOf('Read this immediately') > reloaded.indexOf('Reply to: Consumed during interrupt'), 'Reload must preserve the interrupted/resumed boundary');
    assert(reloaded.at(-2) === 'Read this immediately' && reloaded.at(-1) === 'Resumed after interruption.', 'Replacement reply belongs below its user message');
    // Stop does not silently resend pending instructions; they remain recoverable.
    await page.waitForFunction(() => document.querySelector('#sendButton').dataset.turnId);
    await send(page, 'Keep after stop');
    await page.waitForFunction(() => document.querySelector('[data-steering-state="queued"]'));
    await page.locator('#sendButton').click();
    await page.getByRole('button', { name: 'Restore message', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Restore message', exact: true }).click();
    assert(await page.locator('#prompt').inputValue() === 'Keep after stop', 'Stopping must keep discarded guidance available');
    assert((await protocol()).filter(entry => entry.method === 'turn/start' && entry.params.threadId === threadId).length === 2, 'Stop must not launch a new turn');
    // With no pending guidance, Esc is an ordinary stop, even when an unsent
    // draft exists. It must neither submit that draft nor restart the task.
    await send(page, 'Normal Escape task');
    await page.waitForFunction(() => document.querySelector('#sendButton').dataset.turnId);
    await page.locator('#prompt').fill('Keep this draft after normal Escape');
    await page.locator('#prompt').press('Escape');
    await page.waitForFunction(() => !document.querySelector('#sendButton').dataset.turnId && !document.querySelector('#sendButton').disabled);
    assert(await page.locator('#prompt').inputValue() === 'Keep this draft after normal Escape', 'Normal Esc must preserve an unsent draft');
    assert((await protocol()).filter(entry => entry.method === 'turn/start' && entry.params.threadId === threadId).length === 3, 'Normal Esc must stop without submitting a draft or restarting');
    assert(await page.locator('.native-turn-timeline .loading-shimmer').count() === 0, 'Esc must settle the running tool and its animation');
    await send(page, 'Normal Escape with empty input');
    await page.waitForFunction(() => document.querySelector('#sendButton').dataset.turnId);
    await page.locator('#prompt').press('Escape');
    await page.waitForFunction(() => !document.querySelector('#sendButton').dataset.turnId && !document.querySelector('#sendButton').disabled);
    assert((await protocol()).filter(entry => entry.method === 'turn/start' && entry.params.threadId === threadId).length === 4 && await page.locator('#prompt').inputValue() === '', 'Esc with empty input must stop without creating another turn');
    // A history update may reveal an interleaved user message only after tools
    // have already been grouped. Preserve both row outputs while splitting it.
    await page.evaluate(() => {
      const api = globalThis.__codexWebuiDebug; api.startNewTask();
      api.state.active = { id: 'snapshot-thread', cwd: '/tmp', turns: [], canAcceptDirectInput: true };
      const tool = id => ({ id, type: 'commandExecution', status: 'completed', command: `echo ${id}`, aggregatedOutput: `output ${id}` });
      api.syncTurnSnapshot({ id: 'snapshot-turn', status: 'inProgress', items: [tool('a'), tool('b')] });
      const guide = { id: 'native-late-user', type: 'userMessage', content: [{ type: 'text', text: 'Late history guidance' }] };
      const final = { id: 'native-late-final', type: 'agentMessage', phase: 'final_answer', text: 'Response after late guidance.' };
      api.syncTurnSnapshot({ id: 'snapshot-turn', status: 'completed', items: [tool('a'), guide, tool('b'), final] });
      api.syncTurnSnapshot({ id: 'snapshot-turn', status: 'inProgress', items: [tool('a')] });
    });
    const split = await page.evaluate(() => {
      const stream = document.querySelector('[data-turn-id="snapshot-turn"] .turn-event-stream');
      return [...stream.children].map(node => node.matches('[data-agent-activity-group]') ? [...node.querySelectorAll('.activity-item')].map(row => `${row.dataset.itemId}:${row.nextElementSibling.textContent}`).join(',') : node.querySelector('.user-message-text,.message-text')?.textContent.trim());
    });
    assert(split.length === 4 && split[0].includes('a:') && split[0].includes('output a') && split[1] === 'Late history guidance' && split[2].includes('b:') && split[2].includes('output b') && split[3] === 'Response after late guidance.', `Late snapshots must preserve chronology and tool outputs: ${JSON.stringify(split)}`);
    await page.evaluate(() => {
      const api = globalThis.__codexWebuiDebug; api.startNewTask();
      api.state.active = { id: 'aliases-thread', cwd: '/tmp', turns: [], canAcceptDirectInput: true };
      const user = id => ({ id, type: 'userMessage', content: [{ type: 'text', text: 'Identical guide' }] });
      const reply = id => ({ id, type: 'agentMessage', phase: 'commentary', text: 'Identical reply' });
      api.syncTurnSnapshot({ id: 'aliases-turn', status: 'inProgress', items: [{ id: 'opening', type: 'userMessage', content: [{ type: 'text', text: 'Opening' }] }, reply('item-a'), user('user-a'), reply('item-b'), user('user-b'), reply('item-c')] });
      api.syncTurnSnapshot({ id: 'aliases-turn', status: 'inProgress', items: [reply('msg_a'), user('host-user-aliases-2'), reply('msg_b'), user('host-user-aliases-3'), reply('msg_c')] });
    });
    await expectSequence(page, ['Opening', 'Identical reply', 'Identical guide', 'Identical reply', 'Identical guide', 'Identical reply']);
    await page.setViewportSize({ width: 390, height: 844 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'The timeline must fit mobile screens');
    results.push({ transport, repeatedMessages: true, pendingRefresh: true, chronologicalRefresh: true, escapeReceiptRace: true, normalEscapeStops: true, escapePreservesDraft: true, stopRecovery: true, lateSnapshot: true });
    await context.close();
  }
  assert(!errors.length, `Browser errors: ${errors.join('; ')}`);
  console.log(JSON.stringify({ results, browserErrors: errors }, null, 2));
} finally { await browser?.close(); server.kill(); await server.exited; await rm(temporary, { recursive: true, force: true }); }
