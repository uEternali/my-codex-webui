import { renderAttachmentFileIcon } from './user-attachments.js';

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_ATTACHMENTS = 10;

export function clipboardFiles(data) {
  // files and items normally describe the same payload. Prefer files to avoid
  // uploading duplicates, and fall back to items for image-only clipboards.
  const files = Array.from(data?.files || []);
  return files.length ? files : Array.from(data?.items || []).filter(item => item.kind === 'file').map(item => item.getAsFile()).filter(Boolean);
}
function uploadRequestId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export function attachmentInput(text, attachments = []) {
  const input = [];
  if (text.trim()) input.push({ type: 'text', text });
  for (const file of attachments) {
    if (file.isImage) input.push({ type: 'localImage', path: file.path });
    else input.push({ type: 'text', text: `Attached file: ${file.name}\nServer path: ${file.path}\nRead this file as needed for this request.` });
  }
  return input;
}
export function createAttachmentController({ form, prompt, picker, tray, button, translate = x => x, onChange = () => {}, onError = () => {}, fetcher = (...args) => fetch(...args) }) {
  let items = [], sequence = 0;
  const doc = form.ownerDocument;
  async function discard(item, uploaded = null) {
    const id = uploaded?.id || (!item.pending ? item.id : undefined);
    try {
      const response = await fetcher('/api/attachments', { method: 'DELETE', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, uploadId: item.uploadId }) });
      const result = await response.json();
      if (!response.ok || result.warning) throw new Error(translate('Could not confirm removal of the uploaded file. Please try again.'));
      if (result.retained) onError(translate('Attachment removed. Its file was kept because an existing chat still uses it.'));
      return true;
    } catch (error) { onError(error?.message || translate('Could not confirm removal of the uploaded file. Please try again.')); return false; }
  }
  async function removeItem(item) {
    if (item.removing) return;
    item.removing = true; item.removalError = false; item.controller?.abort(); render();
    if (await discard(item)) items = items.filter(value => value !== item);
    else { item.removing = false; item.removalError = true; }
    render();
  }
  function render() {
    tray.replaceChildren(); tray.hidden = !items.length;
    for (const item of items) {
      const card = doc.createElement('div'); card.className = 'composer-attachment'; card.dataset.attachmentId = item.id;
      if (item.isImage && item.path) {
        const image = doc.createElement('img'); image.className = 'composer-attachment-thumbnail'; image.alt = item.name;
        image.src = `/api/images/local?${new URLSearchParams({ path: item.path })}`; card.append(image);
      } else {
        const visual = doc.createElement('span'); visual.innerHTML = renderAttachmentFileIcon(item.name); card.append(visual.firstElementChild);
      }
      const copy = doc.createElement('span'); copy.className = 'composer-attachment-copy';
      const name = doc.createElement('span'); name.className = 'composer-attachment-name'; name.textContent = item.name; name.title = item.name;
      const status = doc.createElement('small'); status.textContent = item.removing ? translate('Removing…') : item.removalError ? translate('Removal failed') : item.pending ? translate('Uploading…') : `${Math.max(1, Math.round(item.size / 1024))} KB`;
      copy.append(name, status); card.append(copy);
      const remove = doc.createElement('button'); remove.type = 'button'; remove.className = 'composer-attachment-remove';
      remove.textContent = '×'; remove.setAttribute('aria-label', translate('Remove {name}', { name: item.name }));
      remove.disabled = Boolean(item.removing);
      remove.onclick = () => removeItem(item);
      card.append(remove); tray.append(card);
    }
    onChange();
  }
  async function addFiles(files) {
    const uploads = [];
    for (const file of Array.from(files || [])) {
      if (items.length >= MAX_ATTACHMENTS) { onError(translate('You can attach up to 10 files at a time.')); break; }
      if (!file.size) { onError(translate('Empty files cannot be attached.')); continue; }
      if (file.size > MAX_ATTACHMENT_BYTES) { onError(translate('Each attachment must be 25 MB or smaller.')); continue; }
      const item = { id: `pending-${++sequence}`, uploadId: uploadRequestId(), name: file.name || (file.type?.startsWith('image/') ? 'image.png' : 'attachment'), size: file.size, pending: true, controller: new AbortController() };
      items.push(item); render();
      uploads.push((async () => {
        let rejected = false;
        try {
          const response = await fetcher('/api/attachments', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(item.name), 'x-file-type': file.type || 'application/octet-stream', 'x-upload-id': item.uploadId }, body: file, signal: item.controller.signal });
          rejected = !response.ok;
          const result = await response.json();
          if (!response.ok) throw new Error(translate(result.error || 'Upload failed. Please try again.'));
          if (!result.path || typeof result.isImage !== 'boolean') throw new Error(translate('Upload failed. Please try again.'));
          if (items.includes(item) && !item.removing) Object.assign(item, result, { pending: false });
          else { Object.assign(item, result, { pending: false }); await discard(item, result); }
        } catch (error) {
          if (items.includes(item) && !item.removing) { items = items.filter(x => x !== item); if (!rejected) void discard(item); if (error?.name !== 'AbortError') onError(error?.message || translate('Upload failed. Please try again.')); }
        } finally { render(); }
      })());
    }
    await Promise.all(uploads);
  }
  button.onclick = () => picker.click();
  picker.addEventListener('change', () => { const files = Array.from(picker.files || []); picker.value = ''; void addFiles(files); });
  prompt.addEventListener('paste', event => {
    const files = clipboardFiles(event.clipboardData);
    if (files.length) { event.preventDefault(); void addFiles(files); }
  });
  form.addEventListener('dragover', event => { if (Array.from(event.dataTransfer?.types || []).includes('Files')) { event.preventDefault(); form.classList.add('attachment-drag-over'); } });
  form.addEventListener('dragleave', event => { if (!form.contains(event.relatedTarget)) form.classList.remove('attachment-drag-over'); });
  form.addEventListener('drop', event => { form.classList.remove('attachment-drag-over'); if (event.dataTransfer?.files?.length) { event.preventDefault(); void addFiles(event.dataTransfer.files); } });
  function clear() { const old = items; items = []; for (const item of old) { item.controller?.abort(); void discard(item); } render(); }
  return {
    addFiles, clear, hasFiles: () => items.length > 0, isUploading: () => items.some(x => x.pending || x.removing || x.removalError),
    take() { if (items.some(x => x.pending || x.removing || x.removalError)) throw new Error(translate('Please wait for attachments to finish uploading.')); const ready = items.map(({ controller, ...x }) => x); items = []; render(); return ready; },
    restore(files) { for (const file of files) if (!items.some(x => x.id === file.id)) items.push({ ...file, pending: false }); render(); },
    snapshot: () => items.map(({ controller, ...x }) => ({ ...x })),
  };
}
