import { createServer } from 'node:net';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { artifact, launchOptions, root } from './browser-runtime.mjs';

function assert(condition, message) { if (!condition) throw new Error(message); }
async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer(); probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => { const port = probe.address().port; probe.close(error => error ? reject(error) : resolve(port)); });
  });
}

const temporary = await mkdtemp(join(tmpdir(), 'webui-turn-status-'));
await mkdir(join(temporary, 'codex'));
const port = await freePort(), base = `http://127.0.0.1:${port}`;
const server = Bun.spawn([process.execPath, 'run', 'server.ts'], {
  cwd: root,
  env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), CODEX_HOME: join(temporary, 'codex'), CODEX_WEBUI_AUTH_STORE: join(temporary, 'password.json'), CODEX_WEBUI_PASSWORD: '', CODEX_WEBUI_ACCESS_TOKEN: '' },
  stdout: 'ignore', stderr: 'inherit',
});
let browser;
try {
  const deadline = Date.now() + 20_000;
  while (true) {
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {}
    if (Date.now() > deadline) throw new Error('Test server did not start');
    await Bun.sleep(100);
  }
  browser = await chromium.launch(launchOptions());
  const context = await browser.newContext({ viewport: { width: 1280, height: 850 }, timezoneId: 'Asia/Shanghai', colorScheme: 'light' });
  await context.addInitScript(() => { if (window === window.top) localStorage.setItem('codex-webui-locale', 'en'); });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => globalThis.__codexWebuiDebug?.state.connected);
  await page.evaluate(() => {
    const api = globalThis.__codexWebuiDebug;
    api.startNewTask();
    api.state.active = { id: 'status-thread', cwd: '/tmp', turns: [], canAcceptDirectInput: true };
    api.state.transport = 'sse';
    window.__statusOriginalFetch = window.fetch;
    window.__statusMode = 'ack';
    window.fetch = async (resource, options = {}) => {
      if (new URL(typeof resource === 'string' ? resource : resource.url, location.href).pathname === '/api/rpc') {
        const request = JSON.parse(options.body || '{}');
        if (request.method === 'turn/start') {
          if (window.__statusMode === 'http503') return new Response(JSON.stringify({ error: 'Service unavailable' }), { status: 503 });
          if (window.__statusMode === 'rpcError') return Response.json({ type: 'rpc/error', error: 'HTTP 429: rate limit exceeded' });
          return Response.json({ type: 'rpc/result', result: { turn: { id: 'status-turn', status: 'inProgress', startedAt: Date.parse('2026-11-08T05:06:15Z') / 1000, items: [] } } });
        }
        return Response.json({ type: 'rpc/result', result: { data: [], thread: { id: api.state.active?.id, turns: [] } } });
      }
      return window.__statusOriginalFetch(resource, options);
    };
  });
  await page.locator('#prompt').fill('Please process this request.');
  await page.locator('#sendButton').click();
  await page.waitForFunction(() => { const node = document.querySelector('[data-turn-live-status]'); return node && !node.hidden; });
  assert(await page.locator('[data-turn-live-status]').textContent() === 'Working', 'The turn/start acknowledgment must show progress without waiting for reasoning');
  await page.screenshot({ path: artifact('turn-working.png') });

  await page.evaluate(() => {
    const api = globalThis.__codexWebuiDebug;
    api.notify('item/completed', { threadId: 'status-thread', turnId: 'status-turn', item: { id: 'reasoning', type: 'reasoning', summary: ['Checked the request.'] } });
    api.notify('item/agentMessage/delta', { threadId: 'status-thread', turnId: 'status-turn', itemId: 'answer', delta: 'The request is complete.' });
  });
  assert(await page.locator('[data-worked-for-divider]').isVisible() === false, 'A streaming response must not yet show a completion footer');
  await page.evaluate(() => {
    const api = globalThis.__codexWebuiDebug;
    const turn = { id: 'status-turn', status: 'completed', startedAt: Date.parse('2026-11-08T05:06:15Z') / 1000, completedAt: Date.parse('2026-11-08T05:07:00Z') / 1000, items: [{ id: 'answer', type: 'agentMessage', phase: 'final_answer', text: 'The request is complete.' }] };
    api.notify('turn/completed', { threadId: 'status-thread', turn });
    api.syncTurnSnapshot(turn);
  });
  const footer = await page.evaluate(() => {
    const turn = document.querySelector('[data-turn-id="status-turn"]'), footer = turn.querySelector('[data-worked-for-divider]'), final = turn.querySelector('[data-local-conversation-final-assistant]');
    return { text: footer.textContent, iso: footer.querySelector('time').dateTime, below: footer.getBoundingClientRect().top >= final.getBoundingClientRect().bottom, hidden: footer.hidden };
  });
  assert(!footer.hidden && footer.text.includes('Worked for 45s') && footer.text.includes('•') && footer.text.includes('13:07') && footer.below && footer.iso === '2026-11-08T05:07:00.000Z', `Incorrect completion footer: ${JSON.stringify(footer)}`);
  await page.screenshot({ path: artifact('turn-completed.png') });

  await page.evaluate(() => {
    const api = globalThis.__codexWebuiDebug;
    api.startNewTask(); api.state.active = { id: 'retry-thread', cwd: '/tmp', turns: [], canAcceptDirectInput: true };
    api.notify('turn/started', { threadId: 'retry-thread', turn: { id: 'retry-turn' } });
    api.notify('error', { threadId: 'retry-thread', turnId: 'retry-turn', willRetry: true, error: { message: 'Reconnecting... 1/5', additionalDetails: 'HTTP 503: upstream temporarily unavailable' } });
    api.notify('error', { threadId: 'retry-thread', turnId: 'retry-turn', willRetry: true, error: { message: 'Reconnecting... 2/5', additionalDetails: 'HTTP 503: upstream temporarily unavailable' } });
    api.notify('error', { threadId: 'another-thread', turnId: 'foreign-turn', error: { message: 'Foreign error' } });
  });
  const retry = await page.locator('[data-turn-error]').textContent();
  assert(retry.includes('Retrying request (2)') && retry.includes('2/5') && retry.includes('HTTP 503'), `Retries must be visible in the conversation: ${retry}`);
  assert(await page.locator('[data-turn-error]').count() === 1, 'Retries must update the current notice; unrelated thread errors must be ignored');
  assert(await page.locator('.native-turn-timeline[data-turn-id="retry-turn"]').getAttribute('aria-busy') === 'true', 'Automatic retry must keep the turn active');
  await page.screenshot({ path: artifact('turn-retrying.png') });
  await page.evaluate(() => globalThis.__codexWebuiDebug.notify('turn/completed', { threadId: 'retry-thread', turn: { id: 'retry-turn', status: 'failed', error: { message: 'HTTP 503: retry limit reached' }, items: [] } }));
  assert((await page.locator('[data-turn-error]').textContent()).includes('Request failed'), 'Terminal failures must replace the retry status');
  assert(await page.locator('#sendButton').getAttribute('data-submit-mode') === 'send', 'A failed turn must not leave a stop button running');

  for (const [mode, expected] of [['http503', 'HTTP 503'], ['rpcError', 'HTTP 429']]) {
    await page.evaluate(mode => {
      const api = globalThis.__codexWebuiDebug;
      api.startNewTask(); api.state.active = { id: 'failed-request-thread', cwd: '/tmp', turns: [], canAcceptDirectInput: true }; window.__statusMode = mode;
    }, mode);
    await page.locator('#prompt').fill('Keep my draft when the request fails.');
    await page.locator('#sendButton').click();
    await page.waitForFunction(() => { const notice = document.querySelector('[data-turn-error]'); return notice && !notice.hidden; });
    const notice = await page.locator('[data-turn-error]').textContent();
    assert(notice.includes(expected), `Rejected ${mode} requests must show their error inline: ${notice}`);
    assert(await page.locator('#prompt').inputValue() === 'Keep my draft when the request fails.', 'Rejected input must remain available for retry');
  }
  await page.screenshot({ path: artifact('turn-request-failed.png') });
  await page.evaluate(() => globalThis.__codexWebuiI18n.setPreference('zh-CN'));
  await page.waitForFunction(() => document.querySelector('[data-turn-error-title]')?.textContent === '请求失败');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => document.querySelector('#sidebar')?.classList.remove('mobile-open'));
  await page.locator('#sidebar').waitFor({ state: 'hidden' });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  assert(!overflow, 'Error details must wrap within the mobile viewport');
  await page.screenshot({ path: artifact('turn-request-failed-mobile.png') });
  const submissionFeedback = [];
  for (const [kind, method, fail] of [
    ['new', 'thread/start', false], ['resume', 'thread/resume', false],
    ['direct', 'turn/start', false], ['steer', 'turn/steer', false],
    ['steer-resume', 'thread/resume', false],
    ['new', 'thread/start', true], ['resume', 'thread/resume', true],
    ['direct', 'turn/start', true], ['steer', 'turn/steer', true],
  ]) {
    const message = `Immediate ${kind} message${fail ? ' that fails' : ''}`;
    await page.evaluate(({ kind, method, fail }) => {
      const api = globalThis.__codexWebuiDebug;
      api.startNewTask({ projectKey: api.state.config.defaultCwd }); api.state.transport = 'sse';
      const thread = { id: 'feedback-thread', cwd: api.state.config.defaultCwd, turns: [], canAcceptDirectInput: !kind.includes('resume') };
      if (kind !== 'new') api.state.active = thread;
      if (kind.startsWith('steer')) api.syncTurnSnapshot({ id: 'feedback-turn', status: 'inProgress', items: [] });
      window.__feedbackPending = false; window.__feedbackRelease = null;
      window.fetch = async (resource, options = {}) => {
        if (new URL(typeof resource === 'string' ? resource : resource.url, location.href).pathname !== '/api/rpc') return window.__statusOriginalFetch(resource, options);
        const request = JSON.parse(options.body || '{}');
        if (request.method === method) {
          await new Promise(resolve => { window.__feedbackRelease = resolve; window.__feedbackPending = true; });
          if (fail) return Response.json({ error: 'Service unavailable' }, { status: 503 });
        }
        if (request.method === 'thread/start' || request.method === 'thread/resume') return Response.json({ type: 'rpc/result', result: { thread: { ...thread, canAcceptDirectInput: true } } });
        const user = { id: 'feedback-user', type: 'userMessage', content: request.params?.input || [] };
        if (request.method === 'turn/start') return Response.json({ type: 'rpc/result', result: { turn: { id: 'feedback-turn', status: 'inProgress', items: [user] } } });
        if (request.method === 'turn/steer') {
          api.notify('item/started', { threadId: thread.id, turnId: 'feedback-turn', item: user });
          return Response.json({ type: 'rpc/result', result: { turnId: 'feedback-turn' } });
        }
        return Response.json({ type: 'rpc/result', result: { data: [], thread } });
      };
    }, { kind, method, fail });
    await page.locator('#prompt').fill(message);
    await page.locator('#prompt').press('Enter');
    await page.waitForFunction(() => window.__feedbackPending);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    const beforeAck = await page.evaluate(() => {
      const bubble = document.querySelector('.user-message'), r = bubble?.getBoundingClientRect(), viewport = document.querySelector('#conversation').getBoundingClientRect();
      return { count: document.querySelectorAll('.user-message').length, text: bubble?.textContent, visible: !!r && r.top >= viewport.top && r.bottom <= viewport.bottom, input: document.querySelector('#prompt').value };
    });
    assert(beforeAck.count === 1 && beforeAck.text === message && beforeAck.visible && beforeAck.input === '', `The ${kind} message must be visible before ${method} responds: ${JSON.stringify(beforeAck)}`);
    if (!fail && kind === 'new') await page.screenshot({ path: artifact('message-immediate-before-ack.png') });
    await page.evaluate(() => window.__feedbackRelease());
    if (fail) {
      await page.waitForFunction(message => document.querySelector('#prompt').value === message && !document.querySelector('.user-turn[data-optimistic-user="true"]'), message);
      assert(await page.locator('.user-message').count() === 0 && (await page.locator('[data-turn-error]').textContent()).includes('503'), `Rejected ${kind} input must roll back and show the error`);
    } else {
      await page.waitForFunction(() => document.querySelector('.user-message') && !document.querySelector('.user-turn[data-optimistic-user="true"]'));
      assert(await page.locator('.user-message').count() === 1 && await page.locator('.user-message').textContent() === message, `The ${kind} server acknowledgment must reconcile to one message`);
    }
    submissionFeedback.push({ kind, delayedMethod: method, immediate: true, result: fail ? 'restored after HTTP 503' : 'one message after acknowledgment' });
  }
  assert(errors.length === 0, `Browser errors: ${errors.join('; ')}`);
  console.log(JSON.stringify({ acknowledgedBeforeReasoning: true, footer, retryNotice: retry, inlineErrors: ['HTTP 503', 'HTTP 429'], chineseLocale: true, mobileOverflow: overflow, submissionFeedback, browserErrors: errors }, null, 2));
} finally {
  await browser?.close(); server.kill(); await server.exited;
  await rm(temporary, { recursive: true, force: true });
}
