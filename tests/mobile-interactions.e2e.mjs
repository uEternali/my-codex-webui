import { chromium, webkit, devices } from 'playwright';
import { artifact, launchOptions } from './browser-runtime.mjs';

const engine = process.env.MOBILE_TEST_ENGINE === 'webkit' ? webkit : chromium;
const browser = await engine.launch(engine === chromium ? launchOptions() : { headless: true });
const results = [];
const assert = (condition, message) => { if (!condition) throw new Error(message); };
try {
  for (const [name, options] of [
    ['android', devices['Pixel 7']],
    ['iphone', devices['iPhone 13']],
    ['mobile-desktop-layout', { ...devices['Pixel 7'], viewport: { width: 980, height: 1800 } }],
    ['iphone-webview-no-notifications', devices['iPhone 13']],
    ['iphone-webview-undefined-notifications', devices['iPhone 13']],
  ]) {
    const context = await browser.newContext(options);
    await context.addInitScript(() => { if (window === window.top) localStorage.setItem('codex-webui-locale', 'en'); });
    if (name === 'iphone-webview-no-notifications') await context.addInitScript(() => { delete window.Notification; });
    if (name === 'iphone-webview-undefined-notifications') await context.addInitScript(() => { Object.defineProperty(window, 'Notification', { configurable: true, value: undefined }); });
    const page = await context.newPage(), errors = [];
    page.setDefaultTimeout(7000);
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error' && message.text().includes('[codex-webui]')) errors.push(message.text()); });
    let phase = 'load';
    try {
      await page.goto(process.env.CODEX_WEBUI_TEST_URL || 'http://127.0.0.1:8898');
      await page.waitForFunction(() => globalThis.__codexWebuiDebug?.state.connected);
      if (name.includes('webview')) {
        assert(await page.locator('#settingsTaskNotifyToggle').isDisabled(), 'Unsupported notifications are disabled without breaking app startup');
        assert(await page.evaluate(() => localStorage.getItem('codex-webui-task-notify') !== 'false'), 'Unsupported notifications do not overwrite the saved preference');
      }
      phase = 'left sidebar';
      await page.locator('#toggleSidebar').tap();
      await page.waitForFunction(() => document.querySelector('#sidebar').classList.contains('mobile-open'));
      await page.locator('#sidebarHelpButton').tap();
      assert(await page.locator('#sidebarHelpMenu').isVisible(), 'Help opens with one tap');
      await page.locator('#sidebarHelpButton').tap();
      await page.locator('#archiveThreadsButton').tap();
      assert(await page.locator('#archiveThreadsButton').getAttribute('aria-expanded') === 'true', 'Archive opens with one tap');
      await page.locator('#archiveThreadsButton').tap();
      assert((await page.locator('#sidebar').boundingBox()).y === 0, 'The mobile sidebar fills the top of the viewport');
      await page.locator('#closeSidebar').tap();
      await page.waitForFunction(() => !document.querySelector('#sidebar').classList.contains('mobile-open'));
      phase = 'right panel';
      await page.locator('#toggleSidePanel').tap();
      assert(await page.locator('#sidePanel').isVisible(), 'Right panel opens with one tap');
      await page.locator('#closeSidePanel').tap();
      assert(await page.locator('#sidePanel').isHidden(), 'Right panel closes with one tap');
      phase = 'summary panel';
      await page.locator('#toggleSummaryPanel').tap();
      assert(await page.locator('#summaryPanel').isVisible(), 'Summary opens with one tap');
      await page.locator('#closeSummaryPanel').tap();
      phase = 'bottom panel';
      await page.locator('#toggleBottomPanel').tap();
      assert(await page.locator('#bottomPanel').isVisible(), 'Bottom panel opens with one tap');
      await page.locator('#closeBottomPanel').tap();
      phase = 'composer controls';
      await page.locator('#modelButton').tap();
      assert(await page.locator('#modelMenu').isVisible(), 'Model menu opens with one tap');
      await page.locator('#modelButton').tap();
      await page.locator('#modeButton').tap();
      assert(await page.locator('#permissionMenu').isVisible(), 'Permission menu opens with one tap');
      await page.locator('#modeButton').tap();
      await page.locator('#composerProjectButton').tap();
      assert(await page.locator('#folderDialog').isVisible(), 'Project picker opens with one tap');
      await page.locator('#folderDialog').press('Escape');
      assert(errors.length === 0, `No page errors: ${JSON.stringify(errors)}`);
      results.push({ name, passed: true, errors });
    } catch (error) {
      console.error(JSON.stringify({ name, phase, errors, error: error.message, state: await page.evaluate(() => ({ ready: !!globalThis.__codexWebuiDebug, width: innerWidth, inert: [...document.querySelectorAll('[inert]')].map(node => node.id || node.className) })) }, null, 2));
      await page.screenshot({ path: artifact(`mobile-${name}-failure.png`) });
      throw error;
    } finally { await context.close(); }
  }
  console.log(JSON.stringify(results, null, 2));
} finally { await browser.close(); }
