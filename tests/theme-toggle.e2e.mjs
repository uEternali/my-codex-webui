import { createServer } from 'node:net';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { chromium, webkit } from 'playwright';
import { artifact, launchOptions, root } from './browser-runtime.mjs';

const assert = (value, message) => { if (!value) throw Error(message); };
const temporary = mkdtempSync(join(homedir(), '.webui-theme-'));
for (const name of ['bin', 'codex', 'workspace']) mkdirSync(join(temporary, name));
const cwd = join(temporary, 'workspace'), control = join(temporary, 'control.json'), log = join(temporary, 'rpc.jsonl');
writeFileSync(join(cwd, 'sample.py'), 'def greet():\n    return "hello"\n');
writeFileSync(control, JSON.stringify({ projects: [{ prefix: 'theme', cwd, count: 1 }] }));
copyFileSync(join(root, 'tests/fixtures/thread-actions-codex.mjs'), join(temporary, 'bin/codex')); chmodSync(join(temporary, 'bin/codex'), 0o700);
const port = await new Promise(resolve => { const probe = createServer(); probe.listen(0, '127.0.0.1', () => { const value = probe.address().port; probe.close(() => resolve(value)); }); });
const base = `http://127.0.0.1:${port}`;
const server = Bun.spawn([process.execPath, 'run', 'server.ts'], { cwd: root, env: { ...process.env,
  PATH: `${join(temporary, 'bin')}:${dirname(process.execPath)}:${process.env.PATH}`, HOST: '127.0.0.1', PORT: String(port), CODEX_HOME: join(temporary, 'codex'), CODEX_WEBUI_CWD: cwd, CODEX_WEBUI_AUTH_STORE: join(temporary, 'auth.json'), CODEX_WEBUI_PASSWORD: '', CODEX_WEBUI_ACCESS_TOKEN: '', ACTION_FIXTURE_CONTROL: control, ACTION_FIXTURE_LOG: log,
}, stdout: 'ignore', stderr: 'inherit' });
let browser, page, phase = 'startup'; const errors = [];
const ready = page => page.waitForFunction(() => globalThis.__codexWebuiDebug?.state.connected && !globalThis.__codexWebuiDebug.state.initializing && !globalThis.__codexWebuiDebug.state.threadLoading);
const expectTheme = (page, theme) => page.waitForFunction(theme => document.documentElement.dataset.theme === theme && getComputedStyle(document.documentElement).colorScheme === theme, theme);
try {
  const deadline = Date.now() + 10000;
  while (true) { try { if ((await fetch(base + '/api/health').then(r => r.json())).codex) break; } catch {} if (Date.now() > deadline) throw Error('Fixture did not start'); await Bun.sleep(30); }
  browser = process.env.PLAYWRIGHT_BROWSER === 'webkit' ? await webkit.launch({ headless: true }) : await chromium.launch(launchOptions());
  const context = await browser.newContext({ viewport: { width: 1280, height: 850 }, colorScheme: 'light' });
  await context.addInitScript(() => { if (window === window.top) localStorage.setItem('codex-webui-locale', 'en'); });
  page = await context.newPage(); page.setDefaultTimeout(8000); page.on('pageerror', error => errors.push(error.message));
  await page.goto(base + '/?thread=theme-0'); await ready(page); await expectTheme(page, 'light');
  assert((await page.locator('.top-actions>button').evaluateAll(nodes => nodes.map(node => node.id))).join(',') === 'toggleTheme,toggleSidebar,toggleBottomPanel,toggleSidePanel,toggleSummaryPanel', 'Theme is the leftmost top action');
  phase = 'system and explicit preferences';
  await page.emulateMedia({ colorScheme: 'dark' }); await expectTheme(page, 'dark');
  assert(await page.evaluate(() => localStorage.getItem('codex-webui-theme')) === null, 'Following the system does not create an explicit override');
  await page.getByRole('button', { name: 'Switch to light mode' }).click(); await expectTheme(page, 'light');
  await page.emulateMedia({ colorScheme: 'light' }); await page.emulateMedia({ colorScheme: 'dark' }); await expectTheme(page, 'light');
  assert(await page.evaluate(() => localStorage.getItem('codex-webui-theme')) === 'light', 'A manual choice survives system changes');
  phase = 'code highlighting and live terminals';
  await page.locator('#toggleSidePanel').click(); await page.locator('[data-side-panel-action=files]').click();
  await page.locator('[data-file-path="sample.py"]').click(); await page.locator('.file-preview-code .hljs-keyword').first().waitFor();
  assert(await page.locator('.file-preview-code .hljs-keyword').first().evaluate(node => getComputedStyle(node).color) === 'rgb(155, 42, 124)', 'Light syntax follows the explicit light theme on a dark OS');
  await page.locator('#toggleBottomPanel').click();
  await page.waitForFunction(() => globalThis.__codexTerminal?.term && globalThis.__codexTerminal.state.ws?.readyState === 1);
  assert(await page.evaluate(() => getComputedStyle(document.body).backgroundColor === 'rgb(250, 250, 250)' && globalThis.__codexTerminal.term.options.theme.background === '#fafafa' && globalThis.__codexTerminal.term.options.minimumContrastRatio === 4.5), 'Light mode uses a soft gray background and makes low-contrast terminal colors legible');
  await page.evaluate(() => { window.__themeTerminal = globalThis.__codexTerminal.term; window.__themeSocket = globalThis.__codexTerminal.state.ws; });
  await page.locator('#toggleTheme').click(); await expectTheme(page, 'dark');
  assert(await page.locator('.file-preview-code .hljs-keyword').first().evaluate(node => getComputedStyle(node).color) === 'rgb(216, 161, 230)', 'Existing syntax highlighting switches with the page');
  assert(await page.evaluate(() => globalThis.__codexTerminal.term === window.__themeTerminal && globalThis.__codexTerminal.state.ws === window.__themeSocket && globalThis.__codexTerminal.term.options.theme.background === '#242424' && globalThis.__codexTerminal.term.options.minimumContrastRatio === 1), 'Switching updates an existing terminal without restarting it and retains the original dark palette');
  await page.locator('#closeBottomPanel').click(); await page.locator('#closeSidePanel').click();
  phase = 'dialog and persistence';
  await page.locator('.thread-item[data-id="theme-0"]').hover();
  await page.locator('.thread-item[data-id="theme-0"] .thread-more').click(); await page.locator('[data-thread-action=delete]').click();
  const contrast = await page.locator('#confirmationDialog [value=confirm]').evaluate(node => ({ background: getComputedStyle(node).backgroundColor, foreground: getComputedStyle(node).color }));
  assert(contrast.background === 'rgb(242, 242, 242)' && contrast.foreground === 'rgb(36, 36, 36)', 'Dark confirmation keeps its primary action legible');
  await page.locator('#confirmationDialog [value=cancel]').click();
  await page.reload({ waitUntil: 'domcontentloaded' });
  assert(await page.evaluate(() => document.documentElement.dataset.theme) === 'dark', 'Saved preference is applied before the application connects');
  await ready(page); await expectTheme(page, 'dark');
  const second = await context.newPage(); await second.goto(base); await ready(second); await expectTheme(second, 'dark');
  await second.locator('#toggleTheme').click(); await expectTheme(page, 'light');
  await second.close();
  phase = 'mobile and localization';
  await page.setViewportSize({ width: 320, height: 650 });
  const layout = await page.locator('.top-actions').evaluate(node => { const rect = node.getBoundingClientRect(); return { left: rect.left, right: rect.right, width: innerWidth, heights: [...node.children].map(child => child.getBoundingClientRect().height) }; });
  assert(layout.left >= 0 && layout.right <= layout.width && layout.heights.every(height => height === 32), 'All five actions remain reachable at 320px');
  await page.evaluate(() => globalThis.__codexWebuiI18n.setPreference('zh-CN'));
  await page.getByRole('button', { name: '切换为深色模式' }).click(); await expectTheme(page, 'dark');
  await page.screenshot({ path: artifact('theme-dark-mobile.png') });
  await page.setViewportSize({ width: 1280, height: 850 }); await page.screenshot({ path: artifact('theme-dark-desktop.png') });
  const calls = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  assert(!calls.some(call => ['turn/start', 'turn/interrupt', 'thread/delete'].includes(call.method)), 'Theme and cancelled confirmations never change chat tasks or data');
  assert(!errors.length, errors.join('; '));
  console.log(JSON.stringify({ ok: true, system: true, persistence: true, crossTab: true, liveTerminal: true, syntax: true, mobile: true, errors }));
} catch (error) {
  console.error('Phase:', phase, error, 'Browser errors:', errors);
  await page?.screenshot({ path: artifact('theme-toggle-failure.png'), timeout: 2000 }).catch(() => {}); throw error;
} finally { if (browser) await browser.close(); server.kill(); await server.exited; rmSync(temporary, { recursive: true, force: true }); }
