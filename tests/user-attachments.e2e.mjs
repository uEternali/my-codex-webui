import { createServer } from 'node:net';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';
import { artifact, launchOptions, root } from './browser-runtime.mjs';
import { attachmentInput } from '../public/attachments.js';

const assert = (value, message) => { if (!value) throw Error(message); };
const temporary = mkdtempSync(join(tmpdir(), 'webui-attachment-cards-'));
for (const name of ['bin', 'codex', 'workspace']) mkdirSync(join(temporary, name));
const control = join(temporary, 'control.json'); writeFileSync(control, '{}');
copyFileSync(join(root, 'tests/fixtures/thread-actions-codex.mjs'), join(temporary, 'bin/codex')); chmodSync(join(temporary, 'bin/codex'), 0o700);
const port = await new Promise(resolve => { const probe = createServer(); probe.listen(0, '127.0.0.1', () => { const value = probe.address().port; probe.close(() => resolve(value)); }); });
const base = `http://127.0.0.1:${port}`;
const server = Bun.spawn([process.execPath, 'run', 'server.ts'], { cwd: root, env: { ...process.env,
  PATH: `${join(temporary, 'bin')}:${dirname(process.execPath)}:${process.env.PATH}`, HOST: '127.0.0.1', PORT: String(port),
  CODEX_HOME: join(temporary, 'codex'), CODEX_WEBUI_CWD: join(temporary, 'workspace'), CODEX_WEBUI_UPLOAD_DIR: join(temporary, 'uploads'),
  CODEX_WEBUI_AUTH_STORE: join(temporary, 'auth.json'), CODEX_WEBUI_PASSWORD: '', CODEX_WEBUI_ACCESS_TOKEN: '',
  ACTION_FIXTURE_CONTROL: control, ACTION_FIXTURE_LOG: join(temporary, 'rpc.jsonl'),
}, stdout: 'ignore', stderr: 'inherit' });
const rpc = async (method, params) => {
  const value = await fetch(base + '/api/rpc', { method: 'POST', headers: { 'content-type': 'application/json', Origin: base }, body: JSON.stringify({ id: 1, method, params }) }).then(r => r.json());
  assert(value.type === 'rpc/result', `${method}: ${JSON.stringify(value)}`); return value.result;
};
const upload = (name, body) => fetch(base + '/api/attachments', { method: 'POST', headers: { 'x-file-name': encodeURIComponent(name) }, body }).then(r => r.json());
let browser, page, phase = 'startup'; const errors = [], results = [];
try {
  const deadline = Date.now() + 10000;
  while (true) { try { if ((await fetch(base + '/api/health').then(r => r.json())).codex) break; } catch {} if (Date.now() > deadline) throw Error('Fixture did not start'); await Bun.sleep(30); }
  browser = await chromium.launch(launchOptions());
  const image = readFileSync(join(root, 'public/assets/codex-app-icon-128.png'));
  const files = [await upload('screenshot.png', image), await upload('download_mll_ubuntu.sh', '#!/bin/sh\necho example\n'), await upload('report.pdf', '%PDF-1.4\nexample\n'), await upload('data.csv', 'a,b\n1,2\n'), await upload('another.png', image)];
  for (const transport of ['ws', 'sse']) {
    phase = `${transport}: history`;
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addInitScript(() => { if (window === window.top) localStorage.setItem('codex-webui-locale', 'en'); });
    page = await context.newPage(); page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
    if (transport === 'sse') await page.routeWebSocket('**/ws', socket => socket.close());
    const thread = (await rpc('thread/start', {})).thread;
    await rpc('turn/start', { threadId: thread.id, input: attachmentInput('Please compare these attachments.', files) });
    await rpc('turn/interrupt', { threadId: thread.id });
    await page.goto(`${base}/?thread=${thread.id}`);
    const ready = () => page.waitForFunction(() => globalThis.__codexWebuiDebug?.state.connected && !globalThis.__codexWebuiDebug.state.initializing && !globalThis.__codexWebuiDebug.state.threadLoading);
    await ready(); const row = page.locator('.user-turn').filter({ hasText: 'Please compare these attachments.' });
    await row.locator('.user-attachment').nth(4).waitFor();
    assert(await row.locator('.user-message').textContent() === 'Please compare these attachments.', 'Wire paths and model instructions are hidden');
    assert(await row.locator('.user-attachment').count() === 5 && await row.locator('img').count() === 2, 'Images and files share one attachment row');
    await page.waitForFunction(() => [...document.querySelectorAll('.user-attachments img')].every(img => img.complete && img.naturalWidth));
    const geometry = await row.evaluate(node => {
      const bubble = node.querySelector('.user-message').getBoundingClientRect();
      return { bubble: { top: bubble.top, right: bubble.right }, cards: [...node.querySelectorAll('.user-attachment')].map(card => { const r = card.getBoundingClientRect(); return { width: r.width, height: r.height, bottom: r.bottom, right: r.right }; }) };
    });
    assert(geometry.cards.every(card => card.width === 104 && card.height === 88 && card.bottom < geometry.bubble.top), `Cards are equal size above the bubble: ${JSON.stringify(geometry)}`);
    assert(Math.abs(Math.max(...geometry.cards.map(card => card.right)) - geometry.bubble.right) < 1, 'Attachment row aligns with the right edge of the bubble');
    await page.screenshot({ path: artifact(`user-attachments-${transport}.png`) });
    await row.locator('.user-attachment-image').first().click(); await page.locator('#imageViewer[open]').waitFor();
    assert(await page.locator('#imageViewerTitle').textContent() === 'screenshot.png', 'Image cards open the existing full-size viewer');
    await page.locator('#closeImageViewer').click();
    const downloaded = page.waitForEvent('download'); await row.locator('.user-attachment-file').first().click();
    const downloadPath = await (await downloaded).path(); assert(readFileSync(downloadPath, 'utf8').includes('echo example'), 'File cards download the original content');
    await page.reload(); await ready(); assert(await row.locator('.user-attachment').count() === 5, 'Refresh preserves attachments and clean text');

    phase = `${transport}: paste and remove`;
    const pasted = [];
    page.on('response', async response => { if (response.url().endsWith('/api/attachments') && response.request().method() === 'POST' && response.status() === 201) pasted.push(await response.json()); });
    await page.locator('#prompt').fill('Keep this unsent text');
    await page.locator('#prompt').evaluate(node => {
      const data = new DataTransfer(); data.items.add(new File(['#!/bin/sh\necho pasted'],'pasted.sh',{type:''})); data.items.add(new File(['%PDF-1.4\npasted'],'pasted.pdf',{type:'application/pdf'}));
      data.setData('text/plain','clipboard text must not replace the draft'); node.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));
    });
    await page.waitForFunction(() => document.querySelectorAll('.composer-attachment').length === 2 && !document.querySelector('#composerAttachmentTray').textContent.includes('Uploading'));
    assert(await page.locator('#prompt').inputValue() === 'Keep this unsent text', 'Mixed file clipboard does not insert paths or replace the prompt');
    assert(pasted.length === 2, 'Each copied file uploads once, despite files/items mirrors');
    await page.locator('.composer-attachment').filter({ hasText: 'pasted.sh' }).locator('.composer-attachment-remove').click();
    await page.locator('.composer-attachment').filter({ hasText: 'pasted.sh' }).waitFor({ state: 'hidden' });
    assert(!existsSync(pasted.find(file => file.name === 'pasted.sh').path), 'Removing a completed draft deletes its stored file');

    phase = `${transport}: delayed response cancellation`;
    let release, stored, fetched;
    const held = new Promise(resolve => { release = resolve; }), arrived = new Promise(resolve => { fetched = resolve; });
    await page.route('**/api/attachments', async route => {
      if (route.request().method() !== 'POST' || route.request().headers()['x-file-name'] !== 'slow.txt') return route.continue();
      const response = await route.fetch(); stored = await response.json(); fetched(); await held;
      try { await route.fulfill({ response }); } catch { /* The browser intentionally aborted this upload. */ }
    });
    await page.locator('#attachmentPicker').setInputFiles({ name: 'slow.txt', mimeType: 'text/plain', buffer: Buffer.from('delayed upload response') });
    await arrived; assert(existsSync(stored.path), 'Fixture holds the response after the server saved the file');
    await page.locator('.composer-attachment').filter({ hasText: 'slow.txt' }).locator('.composer-attachment-remove').click();
    await page.locator('.composer-attachment').filter({ hasText: 'slow.txt' }).waitFor({ state: 'hidden' });
    assert(!existsSync(stored.path), 'Pending removal deletes a file even before its response reaches the browser'); release();
    await page.unroute('**/api/attachments');
    await page.locator('.composer-attachment-remove').click(); await page.locator('#composerAttachmentTray').waitFor({ state: 'hidden' });
    assert(pasted.filter(file => file.name.startsWith('pasted.')).every(file => !existsSync(file.path)), 'Other pasted drafts also clean up');

    phase = `${transport}: mobile and attachment-only`;
    await page.setViewportSize({ width: 390, height: 844 });
    const mobile = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth, cards: [...document.querySelectorAll('.user-attachment')].map(card => { const r = card.getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width, height: r.height }; }) }));
    assert(mobile.scrollWidth <= mobile.width && mobile.cards.every(card => card.left >= 0 && card.right <= mobile.width), 'Attachment rows wrap without mobile overflow');
    await page.screenshot({ path: artifact(`user-attachments-mobile-${transport}.png`) });
    await rpc('turn/start', { threadId: thread.id, input: attachmentInput('', [files[0]]) }); await rpc('turn/interrupt', { threadId: thread.id });
    await page.reload(); await ready();
    assert(await page.locator('.user-turn').last().locator('.user-message').isHidden(), 'Image-only messages have no empty text bubble');
    results.push({ transport, mixedCards: 5, refresh: true, pastedFiles: 2, completedRemoval: true, pendingRemoval: true, mobile: true });
    await context.close(); page = null;
  }
  assert(errors.length === 0, `Browser errors: ${errors.join('; ')}`); console.log(JSON.stringify({ results, errors }));
} catch (error) {
  if (page) await page.screenshot({ path: artifact('user-attachments-failure.png') }).catch(() => {});
  throw new Error(`${phase}: ${error.message}`, { cause: error });
} finally { await browser?.close(); server.kill(); await server.exited; rmSync(temporary, { recursive: true, force: true }); }
