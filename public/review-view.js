import { codexIcon } from './codex-icons.js';
import { splitDiffHunk } from './codex-surfaces.js';
import { createFileHighlighter } from './file-highlighter-client.js';
import { fileIcon } from './file-types.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

function lineHtml(line, side, index) {
  const numbers = side === 'unified' ? [line?.oldLine, line?.newLine] : [side === 'old' ? line?.oldLine : line?.newLine];
  return `<div class="review-line file-code-line ${line?.type || 'empty'}">${numbers.map(number => `<span class="file-line-number" aria-hidden="true">${number ?? ''}</span>`).join('')}<span class="review-sign" aria-hidden="true">${line?.type === 'add' ? '+' : line?.type === 'delete' ? '−' : ' '}</span><code${line ? ` data-review-code="${index}" data-review-side="${side}"` : ''}>${escape(line?.text) || '\u200b'}</code></div>`;
}

export function createReviewRenderer({ document: doc, window, t = text => text, formatPath = path => path, highlighter = createFileHighlighter(window) }) {
  const expanded = new Map();
  let highlights = new WeakMap(), sequence = 0;

  function highlightedHunk(hunk, path) {
    if (!highlights.has(hunk)) {
      const sides = ['old', 'new'].map(async side => {
        const lines = hunk.lines.filter(line => line.type !== 'meta' && line.type !== (side === 'old' ? 'add' : 'delete'));
        const html = await highlighter.highlight(path, lines.map(line => line.text).join('\n'));
        return new Map(lines.map((line, index) => [line, html?.[index]]));
      });
      highlights.set(hunk, Promise.all(sides));
    }
    return highlights.get(hunk);
  }

  function renderHunk(hunk, file, preferences) {
    const element = doc.createElement('div'); element.className = 'review-hunk';
    if (hunk.lines.length > 3000 || hunk.lines.reduce((size, line) => size + line.text.length, 0) > 256 * 1024) {
      const message = doc.createElement('div'); message.className = 'review-empty-diff'; message.textContent = t('This diff is too large to preview.'); element.append(message);
      return { element, highlight() {} };
    }
    const indices = new Map(hunk.lines.map((line, index) => [line, index]));
    const split = preferences.mode === 'split';
    const lines = split
      ? splitDiffHunk(hunk).map(row => `<div class="review-split-row"><div class="review-side old">${lineHtml(row.left, 'old', indices.get(row.left))}</div><div class="review-side new">${lineHtml(row.right, 'new', indices.get(row.right))}</div></div>`).join('')
      : hunk.lines.map((line, index) => lineHtml(line, 'unified', index)).join('');
    element.innerHTML = `<div class="review-hunk-head">${escape(hunk.header)}</div>${split ? `<div class="review-column-labels"><span>${escape(t('Before'))}</span><span>${escape(t('After'))}</span></div>` : ''}<div class="review-code-scroll"><div class="file-preview-code review-code ${split ? 'review-split-lines' : 'review-lines'}">${lines}</div></div>`;
    const longest = hunk.lines.reduce((length, line) => Math.max(length, line.text.replace(/\t/g, '    ').length), 0);
    element.querySelector('.review-code').style.setProperty('--review-code-width', `${Math.max(split ? 60 : 30, (longest + 12) * (split ? 2 : 1))}ch`);
    return { element, highlight() {
      void highlightedHunk(hunk, file.path).then(([old, next]) => {
        if (!element.isConnected) return;
        for (const code of element.querySelectorAll('[data-review-code]')) {
          const line = hunk.lines[Number(code.dataset.reviewCode)];
          const html = (code.dataset.reviewSide === 'old' || code.dataset.reviewSide === 'unified' && line.type === 'delete' ? old : next).get(line);
          if (html != null) code.innerHTML = html || '\u200b';
        }
        element.dataset.highlighted = 'true';
      });
    } };
  }

  function file(file, preferences, key = '') {
    const section = doc.createElement('section'); section.className = 'review-file'; section.dataset.path = file.path;
    const id = `review-file-${++sequence}`, expansionKey = `${key}\0${file.path}`;
    const open = expanded.get(expansionKey) ?? preferences.expanded;
    const stats = file.binary ? t('Binary file') : `<span class="plus">+${file.linesAdded || 0}</span><span class="minus">−${file.linesDeleted || 0}</span>`;
    section.innerHTML = `<button type="button" class="review-file-head" aria-expanded="${open}" aria-controls="${id}" title="${escape(file.path)}">${codexIcon('chevronDown', 'review-chevron')}${fileIcon(file.path)}<span class="review-file-name">${escape(formatPath(file.path))}</span>${file.kind && file.kind !== 'update' ? `<span class="review-file-kind">${escape(t({ add: 'Added', delete: 'Deleted', rename: 'Renamed' }[file.kind] || file.kind))}</span>` : ''}<span class="review-file-stats">${stats}</span></button><div id="${id}" class="review-hunks"${open ? '' : ' hidden'}></div>`;
    const body = section.querySelector('.review-hunks');
    let rendered = false;
    function showContent() {
      if (rendered) return;
      rendered = true;
      if (!file.hunks?.length) {
        const message = doc.createElement('div'); message.className = 'review-empty-diff'; message.dataset.i18nUi = '';
        message.textContent = t(file.binary ? 'Binary files cannot be compared as text.' : ['add', 'delete'].includes(file.kind) ? 'Empty file' : 'No saved text diff is available for this change.'); body.append(message);
        if (file.metadata?.length) { const metadata = doc.createElement('pre'); metadata.className = 'review-metadata'; metadata.textContent = file.metadata.join('\n'); body.append(metadata); }
      }
      for (const hunk of file.hunks || []) {
        const renderedHunk = renderHunk(hunk, file, preferences); body.append(renderedHunk.element);
        // The section is attached by the caller before the worker result arrives.
        renderedHunk.highlight();
      }
    }
    const header = section.querySelector('.review-file-head');
    header.onclick = () => {
      const next = body.hidden; body.hidden = !next; header.setAttribute('aria-expanded', String(next)); expanded.set(expansionKey, next);
      if (next) showContent();
    };
    if (open) showContent();
    return section;
  }

  return { file, expandAll() { expanded.clear(); }, reset() { expanded.clear(); highlights = new WeakMap(); } };
}
