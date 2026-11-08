import { createServer } from 'node:net';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';
import { artifact, launchOptions, root } from './browser-runtime.mjs';

const assert = (value, message) => { if (!value) throw new Error(message); };
const temporary = await mkdtemp(join(tmpdir(), 'webui-approval-reload-'));
const bin = join(temporary, 'bin'), home = join(temporary, 'codex'), log = join(temporary, 'responses.jsonl');
await mkdir(bin); await mkdir(home); await writeFile(log, '');
await copyFile(join(root, 'tests/fixtures/approval-codex.mjs'), join(bin, 'codex'));
await chmod(join(bin, 'codex'), 0o700);
const port = await new Promise((resolve, reject) => {
  const probe = createServer(); probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => { const port = probe.address().port; probe.close(error => error ? reject(error) : resolve(port)); });
});
const base = `http://127.0.0.1:${port}`;
const server = Bun.spawn([process.execPath, 'run', 'server.ts'], {
  cwd: root,
  env: { ...process.env, PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH}`, HOST: '127.0.0.1', PORT: String(port), CODEX_HOME: home, CODEX_WEBUI_CWD: temporary, CODEX_WEBUI_AUTH_STORE: join(temporary, 'auth.json'), CODEX_WEBUI_PASSWORD: '', CODEX_WEBUI_ACCESS_TOKEN: '', APPROVAL_FIXTURE_LOG: log },
  stdout: 'ignore', stderr: 'inherit',
});
const responses = async () => (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
const reports = [], errors = [];
let browser;
try {
  const deadline = Date.now() + 15_000;
  while (true) {
    try { if ((await fetch(`${base}/api/health`).then(response => response.json())).codex) break; } catch {}
    if (Date.now() > deadline) throw new Error('Approval fixture server did not start');
    await Bun.sleep(50);
  }
  browser = await chromium.launch(launchOptions());
  for (const transport of ['ws', 'sse']) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 850 }, colorScheme: 'light' });
    await context.addInitScript(() => { if (window === window.top) localStorage.setItem('codex-webui-locale', 'en'); });
    const newPage = async (route = '') => {
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      if (transport === 'sse') await page.routeWebSocket('**/ws', socket => socket.close());
      await page.goto(base + route, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => globalThis.__codexWebuiDebug?.state.connected);
      return page;
    };
    const page = await newPage();
    await page.locator('#composerProjectButton').click(); await page.locator('#projectlessOption').click();
    for (const kind of ['commandExecution', 'fileChange', 'permissions']) {
      console.log('Checking approval restoration:', transport, kind);
      await page.locator('#prompt').fill(`${kind} approval reload regression`);
      await page.locator('#prompt').press('Enter');
      await page.locator('.approval-card').waitFor();
      const pending = await page.evaluate(() => globalThis.__codexWebuiDebug.state.serverRequests.snapshot()[0]);
      assert(pending.method === `item/${kind}/requestApproval`, 'The fixture must present the requested approval kind');
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.locator('.approval-card').waitFor();
      assert(await page.locator('.approval-card').count() === 1, 'Reload must restore one approval card');
      assert(!(await responses()).some(response => response.id === pending.id), 'Reload must never answer a pending approval');
      if (kind === 'commandExecution') {
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.locator('.approval-card').waitFor();
        const threadId = pending.params.threadId;
        await page.evaluate(() => globalThis.__codexWebuiDebug.startNewTask());
        assert(await page.locator('.approval-card').count() === 0, 'Approvals must not leak into another conversation');
        await page.evaluate(id => globalThis.__codexWebuiDebug.openThread(id), threadId);
        await page.locator('.approval-card').waitFor();
        const other = await newPage('?thread=' + threadId);
        await other.locator('.approval-card').waitFor();
        if (transport === 'sse') {
          await other.route('**/api/codex/respond', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Temporary approval reply failure' }) }));
          await other.locator('.approval-deny').click();
          await other.locator('[data-approval-error]').waitFor();
          assert(await other.locator('.approval-card').count() === 1 && await other.locator('.approval-deny').isEnabled(), 'Failed replies must preserve the approval and allow retry');
          assert(!(await responses()).some(response => response.id === pending.id), 'A failed reply must not reach Codex');
          await other.unroute('**/api/codex/respond');
        }
        await page.screenshot({ path: artifact(`approval-restored-${transport}.png`) });
        await other.locator('.approval-deny').click();
        await page.locator('.approval-card').waitFor({ state: 'detached' });
        await other.locator('.approval-card').waitFor({ state: 'detached' });
        const staleStatus = await page.evaluate(id => fetch('/api/codex/respond', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId: id, result: { decision: 'accept' } }) }).then(response => response.status), pending.id);
        assert(staleStatus === 400, 'An already resolved callback must reject duplicate or stale replies');
        assert((await responses()).filter(response => response.id === pending.id).length === 1, 'A callback must reach Codex exactly once');
        await other.close();
      } else {
        await page.locator('.approval-deny').click();
        await page.locator('.approval-card').waitFor({ state: 'detached' });
      }
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => globalThis.__codexWebuiDebug?.state.active?.turns?.at(-1)?.status === 'completed');
      assert(await page.locator('.approval-card').count() === 0, 'Answered approvals must stay gone after reload');
      reports.push({ transport, kind, restored: true, answeredOnce: true });
    }
    await page.locator('#prompt').fill('Interrupt this pending commandExecution approval');
    await page.locator('#prompt').press('Enter');
    await page.locator('.approval-card').waitFor();
    const interruptedId = await page.evaluate(() => globalThis.__codexWebuiDebug.state.serverRequests.snapshot()[0].id);
    await page.locator('#sendButton').click();
    await page.locator('.approval-card').waitFor({ state: 'detached' });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => globalThis.__codexWebuiDebug?.state.active?.turns?.at(-1)?.status === 'interrupted');
    assert(await page.locator('.approval-card').count() === 0 && !(await responses()).some(response => response.id === interruptedId), 'Interrupted approvals must disappear without being granted or denied');
    await context.close();
  }
  assert(errors.length === 0, `Browser errors: ${errors.join('; ')}`);
  console.log(JSON.stringify({ reports, multiWindowSync: true, viewSwitch: true, staleReplyRejected: true, failedReplyRetained: true, interruptedApprovalCleared: true, browserErrors: errors }, null, 2));
} finally {
  await browser?.close(); server.kill(); await server.exited;
  await rm(temporary, { recursive: true, force: true });
}
