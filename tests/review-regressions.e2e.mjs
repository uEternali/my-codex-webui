import { createServer } from 'node:net';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';
import { artifact, launchOptions, root } from './browser-runtime.mjs';

const assert = (value, message) => { if (!value) throw Error(message); };
const temporary = mkdtempSync(join(tmpdir(), 'webui-review-regressions-'));
for (const name of ['bin', 'codex', 'workspace']) mkdirSync(join(temporary, name));
const control = join(temporary, 'control.json'), log = join(temporary, 'rpc.jsonl');
let settings = { historyCount: 45 };
const configure = changes => { Object.assign(settings, changes); writeFileSync(control + '.next', JSON.stringify(settings)); renameSync(control + '.next', control); }; configure({});
copyFileSync(join(root, 'tests/fixtures/thread-actions-codex.mjs'), join(temporary, 'bin/codex')); chmodSync(join(temporary, 'bin/codex'), 0o700);
const port = await new Promise(resolve => { const probe = createServer(); probe.listen(0, '127.0.0.1', () => { const value = probe.address().port; probe.close(() => resolve(value)); }); });
const base = `http://127.0.0.1:${port}`;
const server = Bun.spawn([process.execPath, 'run', 'server.ts'], { cwd: root, env: { ...process.env,
  PATH: `${join(temporary, 'bin')}:${dirname(process.execPath)}:${process.env.PATH}`, HOST: '127.0.0.1', PORT: String(port),
  CODEX_HOME: join(temporary, 'codex'), CODEX_WEBUI_CWD: join(temporary, 'workspace'),
  CODEX_WEBUI_AUTH_STORE: join(temporary, 'auth.json'), CODEX_WEBUI_PASSWORD: '', CODEX_WEBUI_ACCESS_TOKEN: '',
  ACTION_FIXTURE_CONTROL: control, ACTION_FIXTURE_LOG: log,
}, stdout: 'ignore', stderr: 'inherit' });
const protocol = () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const waitFor = async predicate => { const deadline = Date.now() + 7000; while (!predicate()) { if (Date.now() > deadline) throw Error('Protocol deadline'); await Bun.sleep(25); } };
let browser, page, phase = 'startup'; const errors = [], results = [];
try {
  const deadline = Date.now() + 10000;
  while (true) { try { if ((await fetch(base + '/api/health').then(r => r.json())).codex) break; } catch {} if (Date.now() > deadline) throw Error('Fixture did not start'); await Bun.sleep(30); }
  browser = await chromium.launch(launchOptions());
  for (const transport of ['ws', 'sse']) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addInitScript(() => {
      if (window !== window.top) return;
      localStorage.setItem('codex-webui-locale', 'en');
      const Original = window.EventSource;
      window.EventSource = class extends Original { constructor(...args) { super(...args); window.__testEventSource = this; } };
    });
    page = await context.newPage(); page.setDefaultTimeout(8000); page.on('pageerror', error => errors.push(error.message));
    if (transport === 'sse') await page.routeWebSocket('**/ws', socket => socket.close());
    phase = `${transport}: history and title`; await page.goto(`${base}/?thread=long-history`);
    const ready = () => page.waitForFunction(() => globalThis.__codexWebuiDebug?.state.connected && !globalThis.__codexWebuiDebug.state.initializing && !globalThis.__codexWebuiDebug.state.threadLoading);
    await ready();
    assert(await page.locator('#productTitle').textContent() === 'Codex Web UI', 'New product title');
    assert(await page.locator('#productTitle').evaluate(node => node.tagName !== 'BUTTON' && !node.querySelector('.chevron')), 'Product title has no button or dropdown');
    assert(await page.locator('.user-turn').count() === 20, 'Initially render only the newest 20 turns');
    await page.locator('.load-older').click(); assert(await page.locator('.user-turn').count() === 40, 'Load the next history window');
    await page.locator('.load-older').click(); assert(await page.locator('.user-turn').count() === 45, 'Load all history without duplication');
    await page.reload(); await ready(); assert(await page.locator('.user-turn').count() === 20, 'Refresh restores a bounded history window');

    phase = `${transport}: Markdown sanitization`;
    const safe = await page.evaluate(() => {
      const root = document.createElement('div');
      root.innerHTML = window.__renderAssistantMarkdown('<a href="jav&#x61;script:alert(1)">bad</a><svg onload="alert(1)"></svg>\n\n$x^2$\n\n```js\nconst n = 1 < 2;\n```\n\n[file](sandbox:/tmp/report.pdf)');
      return { executable: !!root.querySelector('[href^="javascript:"], [onload], [onerror], script'), math: !!root.querySelector('.katex'), code: root.querySelector('code')?.textContent, file: !!root.querySelector('[data-file-download="/tmp/report.pdf"]') };
    });
    assert(!safe.executable && safe.math && safe.code.includes('1 < 2') && safe.file, `Safe rendering retains math, code and file citations: ${JSON.stringify(safe)}`);

    phase = `${transport}: submission admission and navigation`;
    configure({ startDelay: 700, resumeDelay: 0, resumeReject: false });
    await page.evaluate(() => globalThis.__codexWebuiDebug.startNewTask({ projectKey: globalThis.__codexWebuiDebug.state.config.defaultCwd }));
    const before = protocol().filter(call => call.method === 'thread/start').length;
    await page.locator('#prompt').fill(`Original ${transport}`); await page.locator('#prompt').press('Enter');
    await waitFor(() => protocol().filter(call => call.method === 'thread/start').length > before);
    assert(await page.locator('#sendButton').isDisabled(), 'Disable duplicate initial admission');
    await page.locator('#prompt').fill('A newer draft'); await page.locator('#prompt').press('Enter');
    await page.evaluate(() => globalThis.__codexWebuiDebug.openThread('parent-ws'));
    const navigationDraft = `Draft in another chat ${transport}`; await page.locator('#prompt').fill(navigationDraft);
    await waitFor(() => protocol().some(call => call.method === 'turn/start' && call.params.input.some(part => part.text === `Original ${transport}`)));
    const calls = protocol(), submitted = calls.find(call => call.method === 'turn/start' && call.params.input.some(part => part.text === `Original ${transport}`));
    assert(submitted.params.threadId.startsWith('created-'), 'Submission retains its original target after navigation');
    assert(calls.filter(call => call.method === 'thread/start').length === before + 1, 'Rapid Enter creates only one chat');
    assert(await page.evaluate(() => globalThis.__codexWebuiDebug.state.active.id) === 'parent-ws', 'Late response does not change the selected chat');
    assert(await page.locator('#prompt').inputValue() === navigationDraft, 'Late responses preserve the current draft');

    phase = `${transport}: failed resume preserves new draft`;
    await page.evaluate(() => globalThis.__codexWebuiDebug.openThread('parent-sse'));
    configure({ startDelay: 0, resumeDelay: 500, resumeReject: true });
    await page.locator('#prompt').fill(`Retry me ${transport}`); await page.locator('#prompt').press('Enter');
    await page.locator('#prompt').fill('New text while awaiting response');
    await page.locator('#conversation').getByText('HTTP 503: resume unavailable', { exact: true }).waitFor();
    assert(await page.locator('#prompt').inputValue() === `Retry me ${transport}\n\nNew text while awaiting response`, 'Restore failed input without losing new text');
    configure({ resumeDelay: 0, resumeReject: false });

    if (transport === 'sse') {
      phase = 'SSE: connection recovery';
      const count = protocol().filter(call => call.method === 'model/list').length;
      await page.evaluate(() => window.__testEventSource.onerror(new Event('error')));
      assert(await page.evaluate(() => !globalThis.__codexWebuiDebug.state.connected), 'SSE errors clear the connected state');
      await page.evaluate(() => window.__testEventSource.onmessage({ data: JSON.stringify({ type: 'bridge/status', status: 'connected' }) }));
      await waitFor(() => protocol().filter(call => call.method === 'model/list').length > count);
      await ready();
    }
    await page.screenshot({ path: artifact(`review-regressions-${transport}.png`) });
    results.push({ transport, history: true, sanitizer: true, duplicateAdmission: true, navigation: true, draftRecovery: true });
    await context.close(); page = null;
  }
  phase = 'Review JSON bounds';
  for (const body of ['{', JSON.stringify({ threadId: 'x'.repeat(5000) })]) {
    const response = await fetch(base + '/api/review/patch', { method: 'POST', headers: { Origin: base, 'content-type': 'application/json' }, body });
    assert(response.status === 400 && (await response.json()).error, 'Malformed/oversized patch requests return a JSON error');
  }
  assert((await fetch(base + '/api/health')).ok, 'Rejected requests do not crash the service');
  assert(!errors.length, `Browser errors: ${errors.join('; ')}`); console.log(JSON.stringify({ results, errors, reviewPayloadBounds: true, sseRecovery: true }));
} catch (error) {
  if (page) await page.screenshot({ path: artifact('review-regressions-failure.png') }).catch(() => {});
  throw new Error(`${phase}: ${error.message}`, { cause: error });
} finally { await browser?.close(); server.kill(); await server.exited; rmSync(temporary, { recursive: true, force: true }); }
