export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_ATTACHMENTS = 10;
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
  function render() {
    tray.replaceChildren(); tray.hidden = !items.length;
    for (const item of items) {
      const card = doc.createElement('div'); card.className = 'composer-attachment'; card.dataset.attachmentId = item.id;
      if (item.isImage && item.path) {
        const image = doc.createElement('img'); image.className = 'composer-attachment-thumbnail'; image.alt = item.name;
        image.src = `/api/images/local?${new URLSearchParams({ path: item.path })}`; card.append(image);
      }
      const copy = doc.createElement('span'); copy.className = 'composer-attachment-copy';
      const name = doc.createElement('span'); name.className = 'composer-attachment-name'; name.textContent = item.name; name.title = item.name;
      const status = doc.createElement('small'); status.textContent = item.pending ? translate('Uploading…') : `${Math.max(1, Math.round(item.size / 1024))} KB`;
      copy.append(name, status); card.append(copy);
      const remove = doc.createElement('button'); remove.type = 'button'; remove.className = 'composer-attachment-remove';
      remove.textContent = '×'; remove.setAttribute('aria-label', translate('Remove {name}', { name: item.name }));
      remove.onclick = () => { items = items.filter(x => x !== item); item.controller?.abort(); render(); };
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
      const item = { id: `pending-${++sequence}`, name: file.name || 'image.png', size: file.size, pending: true, controller: new AbortController() };
      items.push(item); render();
      uploads.push((async () => {
        try {
          const response = await fetcher('/api/attachments', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(item.name), 'x-file-type': file.type || 'application/octet-stream' }, body: file, signal: item.controller.signal });
          const result = await response.json();
          if (!response.ok) throw new Error(translate(result.error || 'Upload failed. Please try again.'));
          if (!result.path || typeof result.isImage !== 'boolean') throw new Error(translate('Upload failed. Please try again.'));
          if (items.includes(item)) Object.assign(item, result, { pending: false });
        } catch (error) {
          if (items.includes(item)) { items = items.filter(x => x !== item); if (error?.name !== 'AbortError') onError(error?.message || translate('Upload failed. Please try again.')); }
        } finally { render(); }
      })());
    }
    await Promise.all(uploads);
  }
  button.onclick = () => picker.click();
  picker.addEventListener('change', () => { const files = Array.from(picker.files || []); picker.value = ''; void addFiles(files); });
  prompt.addEventListener('paste', event => {
    const files = Array.from(event.clipboardData?.items || []).filter(x => x.kind === 'file' && x.type.startsWith('image/')).map(x => x.getAsFile()).filter(Boolean);
    if (files.length) { event.preventDefault(); void addFiles(files); }
  });
  form.addEventListener('dragover', event => { if (Array.from(event.dataTransfer?.types || []).includes('Files')) { event.preventDefault(); form.classList.add('attachment-drag-over'); } });
  form.addEventListener('dragleave', event => { if (!form.contains(event.relatedTarget)) form.classList.remove('attachment-drag-over'); });
  form.addEventListener('drop', event => { form.classList.remove('attachment-drag-over'); if (event.dataTransfer?.files?.length) { event.preventDefault(); void addFiles(event.dataTransfer.files); } });
  function clear() { const old = items; items = []; for (const item of old) item.controller?.abort(); render(); }
  return {
    addFiles, clear, hasFiles: () => items.length > 0, isUploading: () => items.some(x => x.pending),
    take() { if (items.some(x => x.pending)) throw new Error(translate('Please wait for attachments to finish uploading.')); const ready = items.map(({ controller, ...x }) => x); items = []; render(); return ready; },
    restore(files) { for (const file of files) if (!items.some(x => x.id === file.id)) items.push({ ...file, pending: false }); render(); },
    snapshot: () => items.map(({ controller, ...x }) => ({ ...x })),
  };
}
