import { createServer } from 'node:net';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { chromium, webkit } from 'playwright';
import { artifact, launchOptions, root } from './browser-runtime.mjs';

const assert = (value, message) => { if (!value) throw Error(message); };
const temporary = mkdtempSync(join(homedir(), '.webui-terminal-tabs-')), control = join(temporary, 'control.json'), log = join(temporary, 'rpc.jsonl');
for (const dir of ['bin', 'codex', 'project-a', 'project-b']) mkdirSync(join(temporary, dir));
const a = join(temporary, 'project-a'), b = join(temporary, 'project-b');
writeFileSync(control, JSON.stringify({ projects: [{ prefix: 'a', cwd: a, count: 1 }, { prefix: 'b', cwd: b, count: 1 }] }));
copyFileSync(join(root, 'tests/fixtures/thread-actions-codex.mjs'), join(temporary, 'bin/codex')); chmodSync(join(temporary, 'bin/codex'), 0o700);
const port = await new Promise(resolve => { const probe = createServer(); probe.listen(0, '127.0.0.1', () => { const port = probe.address().port; probe.close(() => resolve(port)); }); });
const base = `http://127.0.0.1:${port}`;
const server = Bun.spawn([process.execPath, 'run', 'server.ts'], { cwd: root, env: { ...process.env, PATH: `${join(temporary, 'bin')}:${dirname(process.execPath)}:${process.env.PATH}`, HOST: '127.0.0.1', PORT: String(port), CODEX_HOME: join(temporary, 'codex'), CODEX_WEBUI_CWD: a, CODEX_WEBUI_AUTH_STORE: join(temporary, 'auth.json'), CODEX_WEBUI_PASSWORD: '', CODEX_WEBUI_ACCESS_TOKEN: '', ACTION_FIXTURE_CONTROL: control, ACTION_FIXTURE_LOG: log }, stdout: 'ignore', stderr: 'inherit' });
let browser, page;
const errors = [];
const ready = () => page.waitForFunction(() => globalThis.__codexWebuiDebug?.state.connected && !globalThis.__codexWebuiDebug.state.initializing && !globalThis.__codexWebuiDebug.state.threadLoading);
async function command(text) { await page.locator('#bottomTerminalHosts>.terminal-host:not([hidden]) .xterm-helper-textarea').focus(); await page.keyboard.type(text); await page.keyboard.press('Enter'); }
const output = (hostId, expected) => page.waitForFunction(({ hostId, expected }) => {
  const state = globalThis.__codexBottomTerminals.values().find(state => state.hostId === hostId), term = state?.term;
  return term && Array.from({ length: term.buffer.active.length }, (_, i) => term.buffer.active.getLine(i)?.translateToString(true)).includes(expected);
}, { hostId, expected });
try {
  const deadline = Date.now() + 10000;
  while (true) { try { if ((await fetch(base + '/api/health').then(r => r.json())).codex) break; } catch {} if (Date.now() > deadline) throw Error('Fixture did not start'); await Bun.sleep(30); }
  browser = process.env.PLAYWRIGHT_BROWSER === 'webkit' ? await webkit.launch({ headless: true }) : await chromium.launch(launchOptions());
  page = await browser.newPage({ viewport: { width: 1280, height: 850 } }); page.setDefaultTimeout(12000); page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => { if (window === window.top) localStorage.setItem('codex-webui-locale', 'en'); });
  await page.goto(base); await ready(); await page.evaluate(() => globalThis.__codexWebuiDebug.openThread('a-0')); await ready();
  await page.locator('#toggleBottomPanel').click(); await page.waitForFunction(() => document.querySelector('#terminalHost')?.dataset.connected === 'true');
  assert(await page.locator('[data-bottom-panel-action],#bottomPanelLauncher,#bottomPanelUtility').count() === 0, 'The bottom panel offers only terminals');
  await command("export WEBUI_TAB_VALUE=one; printf '\\nFIRST_CWD=%s\\n' \"$PWD\""); await output('terminalHost', `FIRST_CWD=${a}`);
  await page.locator('#newBottomTerminal').click(); await page.waitForFunction(() => document.querySelector('#terminalHost-2')?.dataset.connected === 'true');
  await command("printf '\\nSECOND_VALUE=%s\\n' \"${WEBUI_TAB_VALUE-unset}\""); await output('terminalHost-2', 'SECOND_VALUE=unset');
  await page.evaluate(() => globalThis.__codexWebuiDebug.openThread('b-0')); await ready();
  await page.locator('#newBottomTerminal').click(); await page.waitForFunction(() => document.querySelector('#terminalHost-3')?.dataset.connected === 'true');
  await command("printf '\\nTHIRD_CWD=%s\\n' \"$PWD\""); await output('terminalHost-3', `THIRD_CWD=${b}`);
  await page.locator('#bottomPanelTab').click(); await command("printf '\\nFIRST_RETAINED=%s:%s\\n' \"$WEBUI_TAB_VALUE\" \"$PWD\""); await output('terminalHost', `FIRST_RETAINED=one:${a}`);
  await page.locator('[data-close-terminal="terminal-2"]').click();
  assert(await page.locator('#bottomTerminalHosts>.terminal-host').count() === 2, 'Closing one tab removes only its terminal');
  await command("sleep 1; printf '\\nHIDDEN_SHELL_CONTINUES\\n'"); await page.locator('#closeBottomPanel').click(); await output('terminalHost', 'HIDDEN_SHELL_CONTINUES');
  await page.locator('#toggleBottomPanel').click();
  assert(await page.evaluate(() => globalThis.__codexBottomTerminals.values().length) === 2, 'Hiding and reopening the panel retains both shells');
  await page.locator('#bottomPanelTab-3').click(); await command('exit'); await page.waitForFunction(() => globalThis.__codexBottomTerminals.active.exited);
  await page.locator('#bottomPanelTab').click(); await page.locator('#bottomPanelTab-3').click();
  assert(await page.evaluate(() => globalThis.__codexBottomTerminals.active.ws) === null, 'An exited shell is not automatically relaunched by selecting its tab');
  await page.setViewportSize({ width: 390, height: 700 });
  for (let i = 0; i < 5; i++) await page.locator('#newBottomTerminal').click();
  const layout = await page.evaluate(() => { const plus = document.querySelector('#newBottomTerminal').getBoundingClientRect(); return { width: innerWidth, scrollWidth: document.documentElement.scrollWidth, plusRight: plus.right }; });
  assert(layout.scrollWidth <= layout.width && layout.plusRight <= layout.width, 'Many tabs scroll inside the mobile toolbar and keep the new-tab button reachable');
  await page.screenshot({ animations: 'disabled', path: artifact(`terminal-tabs-${process.env.PLAYWRIGHT_BROWSER || 'chromium'}.png`) });
  assert(!errors.length, errors.join('; '));
  const calls = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  assert(!calls.some(call => ['thread/resume', 'turn/start'].includes(call.method)), 'Terminal work never resumes or starts a Codex turn');
  console.log(JSON.stringify({ independentShells: true, projectCwd: true, preservedShells: true, exitedShell: true, layout, errors }, null, 2));
} catch (error) { if (page) await page.screenshot({ animations: 'disabled', path: artifact('terminal-tabs-failure.png') }).catch(() => {}); throw error; }
finally { await browser?.close(); server.kill(); await server.exited; rmSync(temporary, { recursive: true, force: true }); }
