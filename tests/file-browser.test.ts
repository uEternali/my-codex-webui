import { afterEach, expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { createFileBrowser } from '../public/file-browser.js';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });
const flush = () => Bun.sleep(1);
const json = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
const text = (path, value) => ({ kind: 'text', path, name: path.split('/').at(-1), text: value, encoding: 'UTF-8', lineCount: value.split('\n').length, size: value.length, fileUrl: `file:///project/${path}` });
function setup(fetcher, initial = '/project', refreshInterval = 3000) {
  const dom = new JSDOM('<section id="files"></section>', { pretendToBeVisual: true });
  const panel = dom.window.document.querySelector('section')!;
  let cwd = initial;
  const browser = createFileBrowser({ panel, getCwd: () => cwd, fetcher, refreshInterval });
  cleanup.push(() => { browser.dispose(); dom.window.close(); });
  return { panel, browser, doc: dom.window.document, root: value => { cwd = value; browser.setCwd(value); } };
}

test('loads directories lazily and keeps independent file tabs without changing the workspace', async () => {
  const calls: string[] = [];
  const { panel, browser } = setup(async url => {
    const u = new URL(url, 'http://test'), path = u.searchParams.get('path') || ''; calls.push(u.pathname + ':' + path);
    if (u.pathname.endsWith('/tree')) return json({ entries: path ? [{ name: 'a.txt', path: 'src/a.txt', kind: 'file' }] : [{ name: 'src', path: 'src', kind: 'folder' }, { name: 'b.txt', path: 'b.txt', kind: 'file' }] });
    return json(text(path, path));
  });
  await flush(); expect(calls).toEqual(['/api/files/tree:']);
  (panel.querySelector('[data-file-path="src"]') as HTMLButtonElement).click(); await flush();
  expect(calls).toContain('/api/files/tree:src');
  browser.openFile('src/a.txt'); browser.openFile('b.txt'); await flush();
  expect(panel.querySelectorAll('[data-file-tabs] [role=tab]')).toHaveLength(2);
  expect(panel.querySelector('.file-preview-pane:not([hidden]) code')?.textContent).toBe('b.txt');
  browser.openFile('src/a.txt'); await flush();
  expect(panel.querySelectorAll('[data-file-tabs] [role=tab]')).toHaveLength(2);
  expect(panel.querySelector('.file-preview-pane:not([hidden]) code')?.textContent).toBe('src/a.txt');
  (panel.querySelector('[data-close-file="src/a.txt"]') as HTMLButtonElement).click();
  expect(panel.querySelectorAll('[data-file-tabs] [role=tab]')).toHaveLength(1);
  expect(panel.querySelector('.file-preview-pane:not([hidden]) code')?.textContent).toBe('b.txt');
  expect(panel.querySelector('[data-file-root]')?.getAttribute('title')).toBe('/project');
});

test('ignores stale file responses after switching projects, even if the path is identical', async () => {
  let release: (value: Response) => void = () => {};
  const { panel, browser, root } = setup(async url => {
    const u = new URL(url, 'http://test');
    if (u.pathname.endsWith('/tree')) return json({ entries: [] });
    if (u.searchParams.get('cwd') === '/project') return new Promise<Response>(resolve => { release = resolve; });
    return json(text('same.txt', 'new project'));
  });
  browser.openFile('same.txt'); await flush(); root('/another'); browser.openFile('same.txt'); await flush();
  release(json(text('same.txt', 'stale project'))); await flush();
  expect(panel.querySelectorAll('[data-file-tabs] [role=tab]')).toHaveLength(1);
  expect(panel.querySelector('code')?.textContent).toBe('new project');
  expect(panel.textContent).not.toContain('stale project');
});

test('closing a pending file cannot resurrect it when its response arrives', async () => {
  let release: (value: Response) => void = () => {};
  const { panel, browser } = setup(async url => new URL(url, 'http://test').pathname.endsWith('/tree') ? json({ entries: [] }) : new Promise<Response>(resolve => { release = resolve; }));
  browser.openFile('pending.txt'); await flush();
  (panel.querySelector('[data-close-file]') as HTMLButtonElement).click();
  release(json(text('pending.txt', 'late'))); await flush();
  expect(panel.querySelectorAll('.file-preview-pane')).toHaveLength(0);
  expect(panel.querySelector('[data-file-placeholder]')?.hasAttribute('hidden')).toBe(false);
});

test('renders file contents as literal text and exposes retry after upstream failures', async () => {
  let fail = true;
  const { panel, browser } = setup(async url => {
    if (new URL(url, 'http://test').pathname.endsWith('/tree')) return json({ entries: [] });
    if (fail) return new Response(JSON.stringify({ error: 'HTTP 503: unavailable' }), { status: 503 });
    return json(text('index.html', '<img src=x onerror=alert(1)>'));
  });
  browser.openFile('index.html'); await flush(); expect(panel.textContent).toContain('HTTP 503: unavailable');
  fail = false; (panel.querySelector('.file-preview-body .file-browser-message button') as HTMLButtonElement).click(); await flush();
  expect(panel.querySelector('.file-preview-body img')).toBeNull();
  expect(panel.querySelector('code')?.textContent).toBe('<img src=x onerror=alert(1)>');
});

test('empty pages require a project and do not silently browse the home directory', async () => {
  const { panel, root } = setup(async () => { throw Error('No request should be made'); }, '');
  await flush(); expect(panel.querySelector('[data-files-layout]')?.hasAttribute('hidden')).toBe(true);
  expect(panel.textContent).toContain('Choose a project or open a chat');
  root(null); await flush(); expect(panel.querySelectorAll('[data-file-tabs] [role=tab]')).toHaveLength(0);
});

test('background refresh detects edits and new files while unchanged versions retain DOM and scroll', async () => {
  let revision = '1', contents = 'first', extra = false; const calls: URL[] = [];
  const { panel, browser } = setup(async url => {
    const u = new URL(url, 'http://test'); calls.push(u);
    if (u.searchParams.get('revision') === revision) return json({ unchanged: true, revision });
    return json(u.pathname.endsWith('/tree')
      ? { revision, entries: [{ path: 'main.py', name: 'main.py', kind: 'file' }, ...(extra ? [{ path: 'new.cpp', name: 'new.cpp', kind: 'file' }] : [])] }
      : { ...text('main.py', contents), revision });
  });
  await flush(); browser.openFile('main.py'); await flush();
  const original = panel.querySelector('code'), row = panel.querySelector('[data-file-path="main.py"]');
  const body = panel.querySelector('.file-preview-body')!; body.scrollTop = 42;
  await browser.refresh({ background: true });
  expect(panel.querySelector('code')).toBe(original); expect(panel.querySelector('[data-file-path="main.py"]')).toBe(row);
  expect(body.scrollTop).toBe(42); expect(calls.filter(u => u.searchParams.get('revision') === '1')).toHaveLength(2);
  revision = '2'; extra = true; contents = 'changed'; await browser.refresh({ background: true });
  expect(panel.querySelector('[data-file-path="new.cpp"]')).not.toBeNull(); expect(panel.querySelector('code')?.textContent).toBe('changed'); expect(body.scrollTop).toBe(42);
});

test('automatic refresh pauses on hidden panels/pages and stops after disposal', async () => {
  let calls = 0;
  const { browser, doc } = setup(async () => { calls++; return json({ entries: [], revision: '1' }); }, '/project', 15);
  await Bun.sleep(45); expect(calls).toBeGreaterThan(1);
  browser.setVisible(false); await flush(); let paused = calls; await Bun.sleep(40); expect(calls).toBe(paused);
  browser.setVisible(true); await Bun.sleep(10); expect(calls).toBeGreaterThan(paused);
  Object.defineProperty(doc, 'visibilityState', { configurable: true, value: 'hidden' }); doc.dispatchEvent(new doc.defaultView!.Event('visibilitychange'));
  await flush(); paused = calls; await Bun.sleep(40); expect(calls).toBe(paused);
  Object.defineProperty(doc, 'visibilityState', { configurable: true, value: 'visible' }); doc.dispatchEvent(new doc.defaultView!.Event('visibilitychange'));
  await Bun.sleep(10); expect(calls).toBeGreaterThan(paused);
  browser.dispose(); paused = calls; await Bun.sleep(30); expect(calls).toBe(paused);
});
