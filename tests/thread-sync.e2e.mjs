import { createServer } from 'node:net';
import { appendFileSync, chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { chromium, webkit } from 'playwright';
import { launchOptions, root } from './browser-runtime.mjs';

const assert = (value, message) => { if (!value) throw Error(message); };
const temporary = mkdtempSync(join(tmpdir(), 'webui-thread-sync-'));
for (const name of ['bin', 'codex', 'workspace', 'codex/sessions']) mkdirSync(join(temporary, name));
const cwd = join(temporary, 'workspace'), control = join(temporary, 'control.json'), log = join(temporary, 'rpc.jsonl');
const line = (type, payload) => JSON.stringify({ type, payload, timestamp: new Date().toISOString() }) + '\n';
const configure = value => { writeFileSync(control + '.next', JSON.stringify(value)); renameSync(control + '.next', control); };
const projects = [];
for (const transport of ['ws', 'sse']) {
  const id = `sync-${transport}`, path = join(temporary, 'codex/sessions', `${id}.jsonl`), items = [], records = [line('event_msg', { type: 'task_started', turn_id: id })];
  for (let i = 0; i < 500; i++) {
    const text = `Result ${i}\n` + 'measured output\n'.repeat(500);
    items.push({ id: `tool-${i}`, type: 'commandExecution', command: `experiment_${i}`, status: 'completed', aggregatedOutput: text, exitCode: 0 });
    records.push(line('response_item', { type: 'custom_tool_call', id: `tool-${i}`, call_id: `call-${i}`, input: `await tools.exec_command({cmd:"experiment_${i}"})` }));
    records.push(line('response_item', { type: 'custom_tool_call_output', call_id: `call-${i}`, output: 'Script completed\nOutput:\n' + JSON.stringify({ exit_code: 0, output: text }) }));
  }
  items.push({ id: 'answer', type: 'agentMessage', phase: 'final_answer', text: 'Current research result.' });
  records.push(line('response_item', { type: 'message', id: 'answer', role: 'assistant', phase: 'final_answer', content: 'Current research result.' }));
  writeFileSync(path, records.join(''));
  projects.push({ prefix: id, cwd, count: 1, threads: [{ path, turns: [{ id, status: 'inProgress', items }], status: { type: 'active' } }] });
}
configure({ projects });
copyFileSync(join(root, 'tests/fixtures/thread-actions-codex.mjs'), join(temporary, 'bin/codex')); chmodSync(join(temporary, 'bin/codex'), 0o700);
const port = await new Promise(resolve => { const probe = createServer(); probe.listen(0, '127.0.0.1', () => { const port = probe.address().port; probe.close(() => resolve(port)); }); });
const base = `http://127.0.0.1:${port}`;
const server = Bun.spawn([process.execPath, 'run', 'server.ts'], { cwd: root, env: { ...process.env,
  PATH: `${join(temporary, 'bin')}:${dirname(process.execPath)}:${process.env.PATH}`, HOST: '127.0.0.1', PORT: String(port),
  CODEX_HOME: join(temporary, 'codex'), CODEX_WEBUI_CWD: cwd, CODEX_WEBUI_AUTH_STORE: join(temporary, 'auth.json'), CODEX_WEBUI_PASSWORD: '', CODEX_WEBUI_ACCESS_TOKEN: '', ACTION_FIXTURE_CONTROL: control, ACTION_FIXTURE_LOG: log,
}, stdout: 'ignore', stderr: 'inherit' });
const calls = () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const waitFor = async predicate => { const deadline = Date.now() + 12000; while (!predicate()) { if (Date.now() > deadline) throw Error('Sync fixture deadline'); await Bun.sleep(30); } };
let browser, phase = 'startup'; const errors = [], results = [];
try {
  const deadline = Date.now() + 10000;
  while (true) { try { if ((await fetch(base + '/api/health').then(r => r.json())).codex) break; } catch {} if (Date.now() > deadline) throw Error('Fixture did not start'); await Bun.sleep(30); }
  browser = process.env.PLAYWRIGHT_BROWSER === 'webkit' ? await webkit.launch({ headless: true }) : await chromium.launch(launchOptions());
  for (const transport of ['ws', 'sse']) {
    const context = await browser.newContext({ viewport: process.env.PLAYWRIGHT_BROWSER === 'webkit' ? { width: 390, height: 844 } : { width: 1280, height: 850 } });
    await context.addInitScript(() => {
      if (window !== window.top) return;
      localStorage.setItem('codex-webui-locale', 'en');
      const original = window.setTimeout;
      window.setTimeout = (callback, delay, ...args) => original(callback, window.__shortRpcDeadline && delay === 45000 ? 500 : delay, ...args);
    });
    const page = await context.newPage(), responses = [], requests = new Map(); let drop = false, dropped = 0;
    const threadId = `sync-${transport}-0`, turnId = `sync-${transport}`;
    const observe = (raw, method) => { if (method !== 'host/thread/live') return; const message = JSON.parse(raw); if (message.result) responses.push({ ...message.result, bytes: Buffer.byteLength(raw) }); };
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', async response => {
      if (!response.url().endsWith('/api/rpc')) return;
      try { const request = response.request().postDataJSON(); observe(await response.text(), request.method); } catch {}
    });
    await page.routeWebSocket('**/ws', socket => {
      if (transport === 'sse') { socket.close(); return; }
      const upstream = socket.connectToServer();
      socket.onMessage(raw => { const request = JSON.parse(raw); requests.set(request.id, request); upstream.send(raw); });
      upstream.onMessage(raw => {
        const response = JSON.parse(raw), request = requests.get(response.id);
        observe(raw, request?.method);
        if (drop && request?.method === 'host/thread/live') { drop = false; dropped++; return; }
        socket.send(raw);
      });
    });
    phase = `${transport}: unchanged active history`;
    await page.goto(`${base}/?thread=${threadId}`);
    await page.waitForFunction(() => globalThis.__codexWebuiDebug?.state.connected && !globalThis.__codexWebuiDebug.state.initializing && !globalThis.__codexWebuiDebug.state.threadLoading);
    await waitFor(() => responses.filter(value => value.unchanged).length >= 3);
    const first = responses.find(value => value.turn), small = responses.filter(value => value.unchanged);
    assert(first.bytes > 3_000_000 && small.every(value => value.bytes < 400), `Only the first live snapshot is full: ${first?.bytes}, ${small.map(x => x.bytes)}`);
    assert(!calls().some(call => call.method === 'thread/turns/list' && call.params.threadId === threadId), 'Unchanged active history needs no native full reads');
    assert(calls().filter(call => call.method === 'thread/goal/get' && call.params.threadId === threadId).length === 1, 'Goal fallback is not coupled to every live poll');

    phase = `${transport}: new events and completion`;
    const path = projects.find(project => project.prefix === turnId).threads[0].path;
    appendFileSync(path, line('response_item', { type: 'message', id: 'new-answer', role: 'assistant', content: 'New result after conditional polling.' }));
    await page.locator('#conversation').getByText('New result after conditional polling.', { exact: true }).waitFor();
    const completed = { ...projects.find(project => project.prefix === turnId).threads[0].turns[0], status: 'completed' };
    configure({ projects, turnSnapshots: { [threadId]: [completed] } }); await Bun.sleep(60);
    const nativesBefore = calls().filter(call => call.method === 'thread/turns/list' && call.params.threadId === threadId).length;
    appendFileSync(path, line('event_msg', { type: 'task_complete', turn_id: turnId }));
    await page.waitForFunction(id => document.querySelector(`[data-turn-id="${id}"]`)?.dataset.turnStatus === 'completed', turnId);
    const idleBefore = responses.filter(value => value.unchanged && !value.active).length;
    await waitFor(() => responses.filter(value => value.unchanged && !value.active).length >= idleBefore + 2);
    assert(calls().filter(call => call.method === 'thread/turns/list' && call.params.threadId === threadId).length === nativesBefore + 1, 'Completion refreshes native history once, then skips unchanged full reads');

    phase = `${transport}: reopening resets the revision`;
    await page.evaluate(() => globalThis.__codexWebuiDebug.openThread('parent-ws'));
    const before = responses.length;
    await page.evaluate(id => globalThis.__codexWebuiDebug.openThread(id), threadId);
    await waitFor(() => responses.length > before);
    assert(!responses[before].unchanged, 'Reopening a thread forces a full synchronization');
    if (transport === 'ws') {
      phase = 'WebSocket: response loss and SSE recovery';
      await page.locator('#prompt').fill('Draft survives a lost response');
      await page.evaluate(() => { window.__shortRpcDeadline = true; }); drop = true;
      await page.waitForFunction(() => globalThis.__codexWebuiDebug.state.transport === 'sse' && globalThis.__codexWebuiDebug.state.connected);
      assert(dropped === 1, 'Drop exactly one response while keeping the socket open');
      assert(await page.locator('#prompt').inputValue() === 'Draft survives a lost response', 'Timeout recovery preserves unsent input');
    }
    results.push({ transport, firstBytes: first.bytes, unchangedBytes: small[0].bytes, idleHistoryReads: 1, appendUpdates: true, reconnect: transport === 'ws' });
    await context.close();
  }
  assert(!calls().some(call => ['turn/start', 'turn/interrupt', 'thread/resume', 'thread/delete'].includes(call.method)), 'All diagnostics remain read-only, including response-loss recovery');
  assert(!errors.length, errors.join('; ')); console.log(JSON.stringify({ ok: true, results, errors }));
} catch (error) { console.error('Phase:', phase); throw error; }
finally { await browser?.close(); server.kill(); await server.exited; rmSync(temporary, { recursive: true, force: true }); }
