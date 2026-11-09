import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { parseUnifiedDiff, createReviewPreferences } from '../public/codex-surfaces.js';
import { createReviewRenderer } from '../public/review-view.js';

const file = () => parseUnifiedDiff('diff --git a/main.py b/main.py\n--- a/main.py\n+++ b/main.py\n@@ -10,2 +12,2 @@\n-def old():\n+def next():\n     pass\n').files[0];

test('review reuses preview styles and highlights both versions with their line numbers', async () => {
  const dom = new JSDOM('<main></main>'), doc = dom.window.document, calls = [];
  const renderer = createReviewRenderer({ document: doc, window: dom.window, highlighter: { highlight: async (path, text) => { calls.push([path, text]); return text.split('\n').map(line => line.replace('def', '<span class="hljs-keyword">def</span>')); } } });
  const change = file(), preferences = createReviewPreferences({ mode: 'split' });
  const section = renderer.file(change, preferences, 'turn'); doc.querySelector('main').append(section);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(section.querySelector('.file-preview-code')).not.toBeNull();
  expect(section.querySelectorAll('.hljs-keyword')).toHaveLength(2);
  expect([...section.querySelectorAll('.file-line-number')].map(el => el.textContent)).toEqual(['10', '12', '11', '13']);
  expect(calls).toEqual([['main.py', 'def old():\n    pass'], ['main.py', 'def next():\n    pass']]);
  section.querySelector('button').click();
  expect(section.querySelector('.review-hunks').hidden).toBe(true);
  const replacement = renderer.file(change, { ...preferences, mode: 'unified' }, 'turn'); section.replaceWith(replacement);
  expect(replacement.querySelector('.review-hunks').hidden).toBe(true);
  replacement.querySelector('button').click();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(calls).toHaveLength(2);
  expect(replacement.querySelectorAll('.hljs-keyword')).toHaveLength(2);
  renderer.expandAll();
  expect(renderer.file(change, preferences, 'turn').querySelector('button').getAttribute('aria-expanded')).toBe('true');
});

test('metadata-only and binary files explain the absence of a text comparison safely', () => {
  const dom = new JSDOM('<main></main>'), doc = dom.window.document;
  const renderer = createReviewRenderer({ document: doc, window: dom.window });
  const section = renderer.file({ path: '<img onerror=alert(1)>.bin', binary: true, metadata: ['<script>unsafe()</script>'], hunks: [] }, createReviewPreferences());
  doc.querySelector('main').append(section);
  expect(section.querySelector('.review-empty-diff').textContent).toBe('Binary files cannot be compared as text.');
  expect(section.querySelector('.review-metadata').textContent).toBe('<script>unsafe()</script>');
  expect(section.querySelector('script')).toBeNull();
  expect(section.querySelector('[onerror]')).toBeNull();
});
