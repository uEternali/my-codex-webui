export function replyText(timeline) {
  return [...timeline.querySelectorAll('[data-local-conversation-final-assistant] .message-text')]
    .map(node => node.dataset.raw ?? '').join('\n\n');
}

export async function copyReplyText(text) {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return; }
  } catch { /* HTTP/LAN pages and clipboard-denied browsers use the selection fallback. */ }
  const focused = document.activeElement, selection = document.getSelection();
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i).cloneRange()) : [];
  const cursor = focused && typeof focused.selectionStart === 'number'
    ? [focused.selectionStart, focused.selectionEnd, focused.selectionDirection] : null;
  const field = document.createElement('textarea');
  field.value = text; field.readOnly = true; field.tabIndex = -1;
  field.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;font-size:16px';
  document.body.append(field);
  try {
    field.focus({ preventScroll: true }); field.select(); field.setSelectionRange(0, text.length);
    if (!document.execCommand('copy')) throw new Error('Could not copy reply');
  } finally {
    field.remove();
    if (focused?.isConnected) { focused.focus({ preventScroll: true }); if (cursor) focused.setSelectionRange(...cursor); }
    if (selection) { selection.removeAllRanges(); for (const range of ranges) selection.addRange(range); }
  }
}
