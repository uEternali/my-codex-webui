import { codexIcon } from './codex-icons.js';
import { itemImageReferences, localDownloadUrl, parseFileReference, renderImagePreview } from './rendering.js';

const escapeHtml = value => String(value || '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const uploadPrefix = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}-/i;
const fileBlock = /(?:^|\r?\n)Attached file: ([^\r\n]+)\r?\nServer path: ([^\r\n]+)\r?\nRead this file as needed for this request\.\s*$/;

function filename(path = '') {
  let name = String(path).split(/[\\/]/).at(-1) || 'Image';
  try { name = decodeURIComponent(name); } catch { /* Keep literal filenames with percent signs. */ }
  return name.replace(uploadPrefix, '');
}

// The wire input stays unchanged so Codex and the upload lifecycle can still
// read file paths. Only the user-facing rendering hides our attachment blocks.
// Also accept combined text from saved CLI rollouts after a refresh.
export function userMessageContent(item = {}) {
  const attachments = [], texts = [], seen = new Set();
  const add = file => {
    if (!file.path || seen.has(file.path)) return;
    seen.add(file.path); attachments.push(file);
  };
  const parts = typeof item.content === 'string' ? [{ type: 'text', text: item.content }] : item.content || [];
  for (const part of parts) {
    if (part?.type === 'text' || part?.type === 'input_text') {
      let text = String(part.text || ''), match, files = [];
      while ((match = fileBlock.exec(text))) {
        const path = match[2], reference = parseFileReference(path);
        if (!reference || !uploadPrefix.test(path.split(/[\\/]/).at(-1) || '') || reference.lineStart !== null) break;
        files.unshift({ path, name: match[1], isImage: false });
        text = text.slice(0, match.index).trimEnd();
      }
      if (text) texts.push(text);
      for (const file of files) add(file);
    }
    for (const image of itemImageReferences({ content: [part] })) {
      add({ path: image.source, name: /^data:|^blob:/i.test(image.source) ? 'Image' : filename(image.title), isImage: true });
    }
  }
  for (const image of itemImageReferences({ imagePaths: item.imagePaths })) add({ path: image.source, name: filename(image.title), isImage: true });
  return { text: texts.join('\n'), attachments };
}

export function attachmentFileType(name = '') {
  const extension = String(name).split('.').at(-1)?.toLowerCase() || '';
  const label = /^[a-z0-9+#]{1,8}$/.test(extension) && String(name).includes('.') ? extension.toUpperCase() : 'FILE';
  if (/^(?:zip|gz|bz2|xz|7z|rar|tar|tgz)$/.test(extension)) return { icon: 'archive', tone: 'archive', label };
  if (/^(?:sh|bash|zsh|fish|py|js|jsx|ts|tsx|json|yaml|yml|toml|xml|html|css|scss|sql|go|rs|c|h|cpp|java|rb|ps1|bat|env)$/.test(extension)) return { icon: 'terminal', tone: 'code', label };
  if (/^(?:xls|xlsx|csv|tsv|ods)$/.test(extension)) return { icon: 'file', tone: 'sheet', label };
  if (/^(?:ppt|pptx|odp)$/.test(extension)) return { icon: 'file', tone: 'slides', label };
  if (extension === 'pdf') return { icon: 'file', tone: 'pdf', label };
  if (/^(?:png|jpg|jpeg|gif|webp|heic|avif|bmp|tiff?)$/.test(extension)) return { icon: 'image', tone: 'image', label };
  return { icon: 'file', tone: 'document', label };
}

export function renderAttachmentFileIcon(name) {
  const type = attachmentFileType(name);
  return `<span class="attachment-file-icon attachment-type-${type.tone}" aria-hidden="true">${codexIcon(type.icon)}<small>${type.label}</small></span>`;
}

export function renderUserAttachments(files = [], { cwd = '', translate = x => x } = {}) {
  const cards = files.map(file => {
    if (file.isImage) return renderImagePreview(file.path, { cwd, title: file.name, caption: file.name, className: 'user-attachment user-attachment-image' });
    const reference = parseFileReference(file.path);
    if (!reference || reference.lineStart !== null) return '';
    return `<a class="user-attachment user-attachment-file" href="${escapeHtml(localDownloadUrl(file.path, cwd))}" data-file-download="${escapeHtml(file.path)}" download="${escapeHtml(file.name)}" title="${escapeHtml(file.name)}" aria-label="${escapeHtml(translate('Download {name}', { name: file.name }))}">${renderAttachmentFileIcon(file.name)}<span class="user-attachment-name">${escapeHtml(file.name)}</span></a>`;
  }).join('');
  return cards ? `<div class="user-attachments" aria-label="${escapeHtml(translate('Attachments'))}">${cards}</div>` : '';
}
