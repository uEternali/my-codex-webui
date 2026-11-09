import { createServer } from 'node:net';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { chromium, webkit } from 'playwright';
import { artifact, launchOptions, root } from './browser-runtime.mjs';

const assert = (value, message) => { if (!value) throw Error(message); };
const temporary = mkdtempSync(join(homedir(), '.webui-review-preview-'));
for (const name of ['bin', 'codex', 'project']) mkdirSync(join(temporary, name));
const cwd = join(temporary, 'project');
copyFileSync(join(root, 'tests/fixtures/thread-actions-codex.mjs'), join(temporary, 'bin/codex')); chmodSync(join(temporary, 'bin/codex'), 0o700);
const turn = (id, changes) => ({ id, status: 'completed', items: [{ id: id + '-user', type: 'userMessage', content: [{ type: 'text', text: id }] }, { id: id + '-files', type: 'fileChange', status: 'completed', changes }] });
const controls = { projects: [{ prefix: 'root', cwd, count: 1, threads: [{ turns: [
  turn('add-native', [{ path: cwd + '/main.py', kind: { type: 'add' }, diff: 'def main():\n    print("Hello, world!")\n\nmain()\n' }]),
  turn('update-native', [
    { path: 'main.py', kind: { type: 'update' }, diff: '@@ -1,4 +1,4 @@\n def main():\n-    print("Hello, world!")\n+    print("Updated!")\n \n main()\n' },
    { path: 'raw.bin', kind: { type: 'update' }, diff: 'diff --git a/raw.bin b/raw.bin\nBinary files a/raw.bin and b/raw.bin differ\n' },
  ]),
] }] }] };
const control = join(temporary, 'control.json'); writeFileSync(control, JSON.stringify(controls));
const port = await new Promise(resolve => { const probe = createServer(); probe.listen(0, '127.0.0.1', () => { const port = probe.address().port; probe.close(() => resolve(port)); }); });
const base = `http://127.0.0.1:${port}`;
const server = Bun.spawn([process.execPath, 'run', 'server.ts'], { cwd: root, env: { ...process.env, PATH: `${join(temporary, 'bin')}:${dirname(process.execPath)}:${process.env.PATH}`, HOST: '127.0.0.1', PORT: String(port), CODEX_HOME: join(temporary, 'codex'), CODEX_WEBUI_CWD: cwd, CODEX_WEBUI_AUTH_STORE: join(temporary, 'auth.json'), CODEX_WEBUI_PASSWORD: '', CODEX_WEBUI_ACCESS_TOKEN: '', ACTION_FIXTURE_CONTROL: control, ACTION_FIXTURE_LOG: join(temporary, 'rpc.jsonl') }, stdout: 'ignore', stderr: 'inherit' });
let browser, page; const errors = [], reports = [];
const ready = page => page.waitForFunction(() => globalThis.__codexWebuiDebug?.state.connected && !globalThis.__codexWebuiDebug.state.initializing && !globalThis.__codexWebuiDebug.state.threadLoading);
try {
  const deadline = Date.now() + 10000;
  while (true) { try { if ((await fetch(base + '/api/health').then(r => r.json())).codex) break; } catch {} if (Date.now() > deadline) throw Error('Fixture did not start'); await Bun.sleep(30); }
  browser = process.env.PLAYWRIGHT_BROWSER === 'webkit' ? await webkit.launch({ headless: true }) : await chromium.launch(launchOptions());
  for (const transport of ['ws', 'sse']) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
    await context.addInitScript(() => { if (window === window.top) { localStorage.setItem('codex-webui-locale', 'en'); localStorage.setItem('codex-webui-right-panel-width', '680'); } });
    page = await context.newPage(); page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
    if (transport === 'sse') await page.routeWebSocket('**/ws', socket => socket.close());
    await page.goto(base + '/?thread=root-0'); await ready(page);
    await page.locator('#toggleSidePanel').click(); await page.locator('[data-side-panel-action=review]').click();
    const file = page.locator('.review-file[data-path="main.py"]');
    await file.locator('.review-hunk[data-highlighted=true]').waitFor();
    assert(await file.locator('.hljs-keyword').count() > 0, 'Review code has the same syntax highlighting as file previews');
    assert(await file.locator('.file-preview-code').evaluate(el => getComputedStyle(el).fontSize) === '12px', 'Review shares the readable file preview font');
    assert(await file.locator('.review-line.delete code').textContent() === '    print("Hello, world!")', 'Old contents are available');
    assert(await file.locator('.review-line.add code').textContent() === '    print("Updated!")', 'New contents are available');
    await file.locator('.review-file-head').click(); assert(!await file.locator('.review-hunks').isVisible(), 'Clicking a file collapses its comparison');
    await file.locator('.review-file-head').click(); assert(await file.locator('.review-hunks').isVisible(), 'Clicking a file reopens the comparison');
    await page.locator('#reviewMode').click(); await file.locator('.review-split-row').first().waitFor();
    await file.locator('.review-hunk[data-highlighted=true]').waitFor();
    assert(await file.locator('.review-column-labels').textContent() === 'BeforeAfter', 'Split mode labels the old and new versions');
    assert(await file.locator('.review-side.old .review-line.delete .file-line-number').textContent() === '2', 'Split mode has original line numbers');
    await page.locator('#reviewWrap').click();
    assert(await page.locator('#changeList').evaluate(el => el.classList.contains('wrap')), 'Word wrapping works');
    await page.locator('.review-file[data-path="raw.bin"]').getByText('Binary files cannot be compared as text.', { exact: true }).waitFor();
    let finishPatch;
    await page.route('**/api/review/patch', route => new Promise(resolve => { finishPatch = async () => { await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }); resolve(); }; }));
    const patchRequested = page.waitForRequest(request => new URL(request.url()).pathname === '/api/review/patch');
    await page.locator('#reviewPatch').click(); await patchRequested;
    await page.locator('#reviewTurnSelect').selectOption('add-native');
    const patchFinished = page.waitForResponse(response => new URL(response.url()).pathname === '/api/review/patch');
    await finishPatch(); await patchFinished;
    assert(await page.locator('#reviewTurnSelect').inputValue() === 'add-native', 'A late undo response does not replace the selected comparison');
    assert(!await page.locator('#reviewPatch').isEnabled(), 'Absolute snapshot paths remain viewable without enabling an unsupported undo');
    const added = page.locator('.review-file');
    await added.locator('.review-hunk[data-highlighted=true]').waitFor();
    assert(await added.locator('.review-line.add').count() === 4, 'Native complete-body additions become a real comparison');
    assert((await added.locator('.review-file-name').textContent()) === 'main.py', 'Absolute file paths are displayed relative to the chat project');
    assert(await added.locator('.review-file-stats').textContent() === '+4−0', 'Native added-file counts are correct');
    await page.screenshot({ path: artifact(`review-native-add-${transport}.png`) });
    await page.reload(); await ready(page);
    await page.locator('#toggleSidePanel').click(); await page.locator('[data-side-panel-action=review]').click();
    await page.locator('#reviewTurnSelect').selectOption('add-native'); await page.locator('.review-hunk[data-highlighted=true]').waitFor();
    assert(await page.locator('#changeList .review-line.add').count() === 4, 'Comparisons can be reconstructed after refresh');
    await page.emulateMedia({ colorScheme: 'dark' }); await page.screenshot({ path: artifact(`review-dark-${transport}.png`) });
    reports.push({ transport, nativeBodies: true, beforeAfter: true, turnSelection: true, highlighting: true, refresh: true }); await context.close();
  }
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.goto(base + '/?thread=root-0'); await ready(page); await page.locator('#toggleSidePanel').click(); await page.locator('[data-side-panel-action=review]').click();
  await page.locator('#reviewTurnSelect').selectOption('add-native'); await page.locator('.review-hunk[data-highlighted=true]').waitFor();
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Phone review does not overflow the page');
  assert(await page.locator('#reviewTurnSelect').evaluate(el => getComputedStyle(el).fontSize) === '16px', 'Phone controls do not trigger automatic zoom');
  await page.screenshot({ path: artifact('review-mobile.png') }); await context.close();
  assert(!errors.length, errors.join('\n')); console.log(JSON.stringify({ reports, mobile: true, errors }, null, 2));
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: artifact('review-preview-failure.png') }); throw error;
} finally {
  await browser?.close(); server.kill(); await server.exited; rmSync(temporary, { recursive: true, force: true });
}
