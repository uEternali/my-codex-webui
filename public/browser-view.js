import { browserSandboxFor, normalizeBrowserUrl } from './browser-panel.js';

export function createBrowserView(root, { t = text => text } = {}) {
  const $ = id => root.querySelector(`[data-browser-control="${id}"]`);
  const state = { history: [], index: -1, loadTimer: null, loadRequest: 0 };
  function status(text, tone = 'ready') { $('browserStatus').dataset.tone = tone; $('browserStatusText').textContent = t(text); }
  function controls() {
    const current = state.history[state.index] || '';
    $('browserBack').disabled = state.index <= 0; $('browserForward').disabled = state.index < 0 || state.index >= state.history.length - 1; $('browserRefresh').disabled = !current;
    for (const link of [$('browserOpenExternal'), $('browserNoticeExternal')]) { link.hidden = !current; if (current) link.href = current; }
  }
  function notice(title, text) {
    $('browserNoticeTitle').textContent = t(title); $('browserNoticeDescription').textContent = t(text);
    $('browserNotice').hidden = false; $('browserLoading').hidden = true; $('browserFrameShell').setAttribute('aria-busy', 'false'); status(title, 'error');
  }
  function navigate(value, { push = true } = {}) {
    const result = normalizeBrowserUrl(value);
    if (result.error) { notice('Invalid address', result.error); $('browserUrl').setAttribute('aria-invalid', 'true'); return false; }
    const url = result.url; $('browserUrl').removeAttribute('aria-invalid'); $('browserUrl').value = url;
    if (push && state.history[state.index] !== url) { state.history = state.history.slice(0, state.index + 1); state.history.push(url); state.index = state.history.length - 1; }
    const request = ++state.loadRequest, frame = $('browserFrame'); clearTimeout(state.loadTimer);
    $('browserEmpty').hidden = true; $('browserNotice').hidden = true; $('browserLoading').hidden = false; frame.hidden = false;
    frame.setAttribute('sandbox', browserSandboxFor(url, location.href)); $('browserFrameShell').setAttribute('aria-busy', 'true'); status('Loading page...', 'loading'); controls();
    frame.onload = () => { if (request !== state.loadRequest) return; clearTimeout(state.loadTimer); $('browserLoading').hidden = true; $('browserNotice').hidden = true; $('browserFrameShell').setAttribute('aria-busy', 'false'); status('Loaded. If the page is blank, the site may block embedding.', 'loaded'); };
    frame.onerror = () => { if (request === state.loadRequest) notice('Page could not be loaded', 'The site did not complete the embedded request. Open it externally to continue.'); };
    frame.src = url; state.loadTimer = setTimeout(() => { if (request === state.loadRequest) notice('Page may have blocked embedding', 'This site did not finish loading in the panel. It may block embedded browsers; you can open it externally instead.'); }, 10000);
    return true;
  }
  function move(delta) { const next = state.index + delta; if (next < 0 || next >= state.history.length) return; state.index = next; navigate(state.history[next], { push: false }); }
  $('browserAddressForm').onsubmit = event => { event.preventDefault(); navigate($('browserUrl').value); };
  $('browserBack').onclick = () => move(-1); $('browserForward').onclick = () => move(1);
  $('browserRefresh').onclick = () => state.index >= 0 && navigate(state.history[state.index], { push: false });
  controls();
  return { state, navigate, dispose() { clearTimeout(state.loadTimer); state.loadRequest++; $('browserFrame').onload = $('browserFrame').onerror = null; root.remove(); } };
}
