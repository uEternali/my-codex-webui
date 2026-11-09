import { SideChatTranscript } from './side-chat-state.js';
import { codexIcon } from './codex-icons.js';
import { renderSubagentTurns } from './subagent-preview.js';
import { createClientMessageId } from './steering-state.js';

export function parseSideCommand(text) {
  const value = String(text || '').trim();
  if (value === 'side') return { prompt: '' };
  const match = /^\/side(?:\s+([\s\S]*))?$/.exec(value);
  return match ? { prompt: (match[1] || '').trim() } : null;
}

export function createSideChat({ panel, rpc, context, alignWith = null, t = text => text, onChange = () => {}, onClose = () => {} }) {
  const document = panel.ownerDocument, window = document.defaultView, key = createClientMessageId(), transcriptState = new SideChatTranscript();
  panel.className = 'side-panel-chat';
  panel.innerHTML = `<header class="side-chat-context"><span></span><small></small></header><div class="side-chat-messages" role="log" aria-live="polite"><div data-side-chat-turns></div><div data-side-chat-pending></div><div class="side-chat-progress" role="status" hidden></div><div class="side-chat-notice" role="alert" hidden></div><div class="side-chat-approvals" hidden></div></div><div class="side-chat-composer-shell"><form class="composer side-chat-composer"><textarea data-side-chat-prompt rows="2"></textarea><div class="side-chat-composer-footer"><span data-side-chat-hint></span><button class="send-button" type="submit"><span class="icon-slot"></span></button></div></form></div>`;
  const $ = selector => panel.querySelector(selector), input = $('[data-side-chat-prompt]'), button = $('button[type=submit]');
  const messages = $('.side-chat-messages'), transcript = $('[data-side-chat-turns]'), pending = $('[data-side-chat-pending]'), notice = $('.side-chat-notice'), progress = $('.side-chat-progress');
  let thread = null, turns = [], activeTurnId = null, starting = true, submitting = false, stopping = false, closed = false, releasing = false;
  let startPromise = null, timer = null, frame = null, refreshing = false, revision = 0, optimistic = null, markup = '', creationError = null;
  function alignComposer() {
    const height = alignWith?.composer?.getBoundingClientRect().height;
    if (height > 0) panel.style.setProperty('--side-chat-composer-height', `${height}px`);
    if (alignWith?.dock) $('.side-chat-composer-shell').style.paddingBottom = window.getComputedStyle(alignWith.dock).paddingBottom;
  }
  const composerObserver = alignWith && new window.ResizeObserver(alignComposer);
  if (composerObserver) for (const element of [alignWith.composer, alignWith.dock]) if (element) composerObserver.observe(element);
  function resize() { alignComposer(); }
  function showError(error) { if (closed) return; notice.hidden = false; notice.textContent = error?.message || String(error); }
  function clearError() { notice.hidden = true; notice.textContent = ''; }
  function sync() {
    const busy = submitting || Boolean(activeTurnId);
    input.placeholder = t('Ask a side question…'); input.setAttribute('aria-label', t('Side chat message'));
    input.disabled = releasing;
    button.disabled = closed || releasing || starting || stopping || (!busy && !input.value.trim());
    button.dataset.submitMode = busy ? 'stop' : 'send';
    button.title = t(busy ? 'Stop side chat' : 'Send message');
    button.setAttribute('aria-label', button.title); button.querySelector('.icon-slot').innerHTML = codexIcon(busy ? 'square' : 'arrowUp');
    progress.hidden = !starting && !busy;
    progress.textContent = t(starting ? 'Opening side chat…' : stopping ? 'Stopping…' : 'Processing…');
    $('[data-side-chat-hint]').textContent = t('Temporary · deleted when closed');
    $('.side-chat-context>span').textContent = context.parentThreadId ? t('Context: {title}', { title: context.title }) : t('Side chat');
    $('.side-chat-context>span').title = context.title || '';
    $('.side-chat-context>small').textContent = context.cwd || ''; $('.side-chat-context>small').title = context.cwd || '';
    onChange();
  }
  function render() {
    if (closed) return;
    const atBottom = messages.scrollHeight - messages.clientHeight - messages.scrollTop < 65;
    const next = renderSubagentTurns(turns, { cwd: context.cwd, t });
    if (next !== markup) {
      const expanded = new Set([...transcript.querySelectorAll('details[open][data-preview-item]')].map(node => node.dataset.previewItem));
      transcript.innerHTML = next; markup = next;
      for (const node of transcript.querySelectorAll('details[data-preview-item]')) node.open = expanded.has(node.dataset.previewItem);
    }
    pending.replaceChildren();
    if (optimistic) {
      const row = document.createElement('div'); row.className = 'subagent-user';
      const bubble = document.createElement('div'); bubble.className = 'user-message'; bubble.textContent = optimistic; row.append(bubble); pending.append(row);
    }
    sync(); if (atBottom) messages.scrollTop = messages.scrollHeight;
  }
  function scheduleRender() { if (!frame && !closed) frame = window.requestAnimationFrame(() => { frame = null; render(); }); }
  async function start() {
    if (startPromise) return startPromise;
    creationError = null; starting = true; clearError(); sync();
    startPromise = rpc('host/side/start', { key, ...context }).then(result => {
      if (!closed) { thread = result.thread; panel.dataset.sideChatThread = thread.id; }
      return result;
    }).catch(error => { creationError = error; showError(error); throw error; }).finally(() => { starting = false; if (!closed) sync(); });
    return startPromise;
  }
  function scheduleRefresh() {
    clearTimeout(timer);
    if (!closed && thread) timer = window.setTimeout(() => void refresh(), activeTurnId ? 2400 : 20_000);
  }
  async function refresh() {
    if (closed || !thread || refreshing) return;
    refreshing = true; const requestRevision = revision;
    try {
      const result = await rpc('host/side/read', { key });
      if (!closed && requestRevision === revision) {
        transcriptState.load(result); turns = result.turns || []; activeTurnId = result.activeTurnId || null;
        if(result.error)showError(result.error);
        if (turns.some(turn => turn.items?.some(item => item.type === 'userMessage' && item.content?.some(part => part.text === optimistic)))) optimistic = null;
        render();
      }
    } catch (error) { showError(error); }
    finally { refreshing = false; scheduleRefresh(); }
  }
  function notification(method, params) {
    if (closed || !thread || params.threadId !== thread.id) return;
    revision++;
    transcriptState.notification(method, params);
    const snapshot = transcriptState.snapshot(); turns = snapshot.turns; activeTurnId = snapshot.activeTurnId;
    if (method === 'turn/started') { optimistic = null; clearError(); }
    if (method === 'turn/completed' || method === 'item/started' && params.item?.type === 'userMessage') optimistic = null;
    if (snapshot.error) showError(snapshot.error);
    if (method === 'thread/closed') showError(t('Side chat is no longer available. Close this tab and open a new side chat.'));
    scheduleRender();
  }
  async function stop() {
    if (closed || stopping || (!submitting && !activeTurnId)) return;
    stopping = true; sync();
    try { await rpc('host/side/interrupt', { key }); if (!closed) { activeTurnId = null; await refresh(); } }
    catch (error) { showError(error); }
    finally { stopping = false; if (!closed) sync(); }
  }
  async function send() {
    if (submitting || activeTurnId) return stop();
    const text = input.value.trim(); if (!text || closed) return;
    if (creationError) { startPromise = null; await start().catch(() => {}); if (creationError || closed) return; }
    if (starting) return;
    submitting = true; optimistic = text; input.value = ''; resize(); clearError(); render();
    try {
      const result = await rpc('host/side/send', { key, text, model: context.model, effort: context.effort });
      if (closed) return;
      if (result.turn && !transcriptState.turns.has(result.turn.id)) transcriptState.mergeTurn(result.turn);
      const snapshot=transcriptState.snapshot();turns=snapshot.turns;activeTurnId=snapshot.activeTurnId;
      optimistic = null;
    } catch (error) {
      if (!closed) {
        showError(error); optimistic = null;
        if (!error?.silentTransportSwitch) { input.value = input.value ? text + '\n\n' + input.value : text; resize(); }
      }
    } finally { submitting = false; if (!closed) { render(); void refresh(); } }
  }
  async function close() {
    releasing = true; sync();
    try { await rpc('host/side/close', { key }); dispose(); }
    finally { releasing = false; if (!closed) sync(); }
  }
  function unload() {
    // Best effort on page close/reload; the server lease also releases abandoned
    // ephemeral threads if the browser cannot deliver this request.
    if (!closed) void window.fetch('/api/rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 0, method: 'host/side/close', params: { key } }), keepalive: true }).catch(() => {});
  }
  function dispose() { closed = true; clearTimeout(timer); composerObserver?.disconnect(); if (frame) window.cancelAnimationFrame(frame); window.removeEventListener('pagehide', unload); panel.remove(); }
  $('form').addEventListener('submit', event => { event.preventDefault(); void send(); });
  input.addEventListener('input', () => { resize(); sync(); });
  input.addEventListener('keydown', event => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); if (!submitting && !activeTurnId) void send(); }
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (submitting || activeTurnId) void stop(); else onClose(); }
  });
  window.addEventListener('pagehide', unload);
  void start().then(scheduleRefresh).catch(() => {});
  return {
    notification, refresh, close, dispose, localize: render,
    focus(text = '') { if (text) input.value = input.value ? input.value + '\n\n' + text : text; resize(); sync(); window.requestAnimationFrame(() => !closed && input.focus()); },
    get threadId() { return thread?.id; }, get approvals() { return $('.side-chat-approvals'); }, get busy() { return submitting || Boolean(activeTurnId); },
  };
}
