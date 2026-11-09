import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { highlightFileLines } from '../public/file-highlight.js';
import { fileType } from '../public/file-types.js';
import { createFileHighlighter } from '../public/file-highlighter-client.js';

test('Python/C++ highlight multiline strings and comments without losing line text', () => {
  for (const [language, text] of [
    ['python', 'def hello(name):\n    """first\n    <script>alert(1)</script>\n    last"""\n    return "hello"\n'],
    ['cpp', '#include <iostream>\r\n/* first\r\n   last */\r\nint main() { return 0; }\r\n'],
  ]) {
    const lines = highlightFileLines(text, language)!;
    expect(lines).toHaveLength(text.split(/\r\n|\r|\n/).length);
    const dom = new JSDOM('');
    for (let i = 0; i < lines.length; i++) {
      const code = dom.window.document.createElement('code'); code.innerHTML = lines[i];
      expect(code.textContent).toBe(text.split(/\r\n|\r|\n/)[i]);
      expect(code.querySelector('script, img')).toBeNull();
    }
    expect(lines[2]).toContain(language === 'python' ? 'hljs-string' : 'hljs-comment');
    expect(lines.join('')).toContain('hljs-keyword'); dom.window.close();
  }
});

test('highlights supported grammars and bounds unknown or expensive input', () => {
  for (const [language, text] of [['javascript', 'export const n = 1;'], ['typescript', 'let n: number = 1;'], ['bash', 'echo "$HOME"'], ['json', '{"n":1}'], ['xml', '<main title="ok">Hi</main>']]) {
    expect(highlightFileLines(text, language)?.join('')).toContain('hljs-');
  }
  expect(highlightFileLines('hello', 'unsupported')).toBeNull();
  expect(highlightFileLines('x'.repeat(128 * 1024 + 1), 'python')).toBeNull();
  expect(highlightFileLines('\n'.repeat(3000), 'python')).toBeNull();
});

test('file icons distinguish language types and named config files', () => {
  expect(fileType('main.py').icon).not.toBe(fileType('main.cpp').icon);
  expect(fileType('main.c').icon).not.toBe(fileType('main.cpp').icon);
  expect(fileType('main.TSX').language).toBe('typescript');
  expect(fileType('Dockerfile.dev').language).toBe('dockerfile');
  expect(fileType('.env.local').language).toBe('ini');
  expect(fileType('src', 'folder', true).icon).toBe('default_folder_opened');
  expect(fileType('unknown.xyz').icon).toBe('default_file');
});

test('worker loads only for known source files and pending jobs end on disposal', async () => {
  const workers: any[] = [];
  class Worker {
    constructor(public url) { workers.push(this); }
    onmessage: any; onerror: any; request: any; stopped = false;
    postMessage(request) { this.request = request; }
    terminate() { this.stopped = true; }
  }
  const client = createFileHighlighter({ Worker });
  expect(await client.highlight('notes.txt', 'abc')).toBeNull(); expect(workers).toHaveLength(0);
  const result = client.highlight('main.py', 'return 1'); expect(workers).toHaveLength(1);
  workers[0].onmessage({ data: { id: workers[0].request.id, lines: ['<span class="hljs-keyword">return</span> 1'] } });
  expect(await result).toHaveLength(1);
  const pending = client.highlight('main.cpp', 'int n;'); client.dispose();
  expect(await pending).toBeNull(); expect(workers[0].stopped).toBe(true);
});
