import { codexIcon } from './codex-icons.js';
import { threadRecency } from './sidebar-threads.js';

export function createThreadControls({ rpc, translate: t, confirmAction, titleOf, shortPath, formatTime, getActiveId, onOpen, onUpdate, onRemove, onRestore, onRender, toast }) {
  const $ = selector => document.querySelector(selector);
  const menu = $('#threadActionsMenu'), dialog = $('#renameThreadDialog'), input = $('#renameThreadName');
  const archiveButton = $('#archiveThreadsButton'), archiveList = $('#archivedThreadList');
  const pending = new Set();
  let menuThread = null, menuAnchor = null, renameThread = null, saving = false, composing = false, compositionEnd = 0;
  let archives = [], archiveLoading = false, archiveError = false, archiveCursor = null, archiveVersion = 0;
  let archiveOpen = localStorage.getItem('codex-webui-archive-open') === 'true';

  function errorMessage(message, error) { return `${t(message)}${error?.message ? `: ${error.message}` : ''}`; }
  async function perform(thread, action, failure) {
    if (pending.has(thread.id)) return;
    pending.add(thread.id); onRender();
    try { await action(); }
    catch (error) { toast(errorMessage(failure, error)); }
    finally { pending.delete(thread.id); onRender(); }
  }

  function button(icon, label, thread, handler, className = '') {
    const node = document.createElement('button'); node.type = 'button'; node.className = `thread-action ${className}`;
    node.title = t(label); node.setAttribute('aria-label', t(`${label} “{title}”`, { title: titleOf(thread) }));
    node.innerHTML = codexIcon(icon); node.disabled = pending.has(thread.id);
    node.onkeydown = event => event.stopPropagation();
    node.onclick = event => { event.stopPropagation(); handler(node); };
    return node;
  }

  function createRow(thread, { archived = false } = {}) {
    const row = document.createElement('div'); row.className = `thread-item${archived ? ' archived-thread' : getActiveId() === thread.id ? ' active' : ''}`;
    row.dataset.id = thread.id; row.title = [titleOf(thread), shortPath(thread.cwd)].filter(Boolean).join(' — ');
    const name = document.createElement('span'); name.className = 'thread-name'; name.dataset.i18nIgnore = ''; name.textContent = titleOf(thread);
    const running = document.createElement('span'); running.className = 'thread-running-indicator'; running.hidden = archived || thread.status?.type !== 'active';
    running.setAttribute('role', 'img'); running.setAttribute('aria-label', t('Working')); running.title = t('Working'); running.innerHTML = codexIcon('loaderCircle');
    const meta = document.createElement('span'); meta.className = 'thread-meta';
    const time = document.createElement('time'), date = new Date(threadRecency(thread) * 1000);
    if (date.getTime() > 0) { time.textContent = formatTime(date); time.dateTime = date.toISOString(); time.title = date.toLocaleString(); meta.append(time); }
    const actions = document.createElement('span'); actions.className = 'thread-actions';
    if (archived) {
      actions.append(button('trash', 'Permanently delete chat', thread, () => remove(thread), 'thread-delete'));
      actions.append(button('archiveRestore', 'Restore to original project', thread, () => restore(thread), 'thread-restore'));
    } else {
      const pin = button(thread.pinnedAt ? 'pinOff' : 'pin', thread.pinnedAt ? 'Unpin chat' : 'Pin chat', thread, () => pinThread(thread), 'thread-pin');
      pin.setAttribute('aria-pressed', String(Boolean(thread.pinnedAt))); if (thread.pinnedAt) pin.classList.add('is-pinned');
      const more = button('ellipsis', 'More chat actions', thread, node => toggleMenu(thread, node), 'thread-more');
      more.setAttribute('aria-haspopup', 'menu'); more.setAttribute('aria-controls', 'threadActionsMenu');
      more.setAttribute('aria-expanded', String(menuThread?.id === thread.id));
      if (menuThread?.id === thread.id) { menuAnchor = more; menuThread = thread; }
      actions.append(pin, more);
      row.setAttribute('role', 'button'); row.tabIndex = 0;
      row.onclick = event => { if (!event.target.closest('.thread-actions')) { closeMenu(false); onOpen(thread.id); } };
      row.onkeydown = event => { if (event.target.closest('.thread-actions')) return; if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); closeMenu(false); onOpen(thread.id); } };
    }
    row.append(name, running, meta, actions); return row;
  }

  function closeMenu(returnFocus = true) {
    const anchor = menuAnchor; menu.hidden = true; anchor?.setAttribute('aria-expanded', 'false');
    menuThread = null; menuAnchor = null; if (returnFocus && anchor?.isConnected) anchor.focus();
  }
  function positionMenu() {
    if (!menuThread || !menuAnchor?.isConnected) { closeMenu(false); return; }
    const rect = menuAnchor.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(rect.right - menu.offsetWidth, innerWidth - menu.offsetWidth - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(rect.bottom + 5, innerHeight - menu.offsetHeight - 8))}px`;
  }
  function syncMenu() {
    const archive = menu.querySelector('[data-thread-action="archive"]');
    archive.disabled = !menuThread || pending.has(menuThread.id) || menuThread.status?.type === 'active';
    archive.title = menuThread?.status?.type === 'active' ? t('Stop the task before archiving') : '';
  }
  function toggleMenu(thread, anchor) {
    if (menuThread?.id === thread.id) { closeMenu(); return; }
    closeMenu(false); menuThread = thread; menuAnchor = anchor; menu.hidden = false;
    anchor.setAttribute('aria-expanded', 'true'); syncMenu(); positionMenu(); menu.querySelector('button')?.focus();
  }
  menu.querySelector('[data-thread-action="rename"]').onclick = () => { const thread = menuThread; closeMenu(false); openRename(thread); };
  menu.querySelector('[data-thread-action="archive"]').onclick = () => { const thread = menuThread; closeMenu(false); archiveThread(thread); };
  menu.querySelector('[data-thread-action="delete"]').onclick = () => { const thread = menuThread; closeMenu(false); void remove(thread); };
  menu.onkeydown = event => {
    const buttons = [...menu.querySelectorAll('button:not(:disabled)')], current = buttons.indexOf(document.activeElement);
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeMenu(); }
    else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length; buttons[next]?.focus();
    } else if (event.key === 'Tab') closeMenu(false);
  };
  document.addEventListener('pointerdown', event => { if (!menu.hidden && !menu.contains(event.target) && !menuAnchor?.contains(event.target)) closeMenu(false); });
  document.addEventListener('scroll', event => { if (!menu.hidden && !menu.contains(event.target)) closeMenu(false); }, true);
  addEventListener('resize', () => closeMenu(false));

  function openRename(thread) {
    if (!thread || pending.has(thread.id)) return;
    renameThread = thread; input.value = thread.name || titleOf(thread); $('#renameThreadError').hidden = true;
    dialog.showModal(); input.focus(); input.select();
  }
  function setSaving(value) {
    saving = value; input.disabled = value;
    for (const selector of ['#renameThreadSave', '#renameThreadCancel', '#renameThreadClose']) $(selector).disabled = value;
    $('#renameThreadSave').textContent = t(value ? 'Saving…' : 'Save');
  }
  function closeRename() { if (!saving) dialog.close(); }
  $('#renameThreadClose').onclick = closeRename; $('#renameThreadCancel').onclick = closeRename;
  dialog.addEventListener('cancel', event => { event.stopPropagation(); if (saving) event.preventDefault(); });
  input.addEventListener('compositionstart', () => { composing = true; });
  input.addEventListener('compositionend', () => { composing = false; compositionEnd = Date.now(); });
  input.addEventListener('keydown', event => { if (event.key === 'Enter' && (event.isComposing || event.keyCode === 229 || composing || Date.now() - compositionEnd < 100)) { event.preventDefault(); event.stopPropagation(); } });
  input.addEventListener('input', () => { $('#renameThreadError').hidden = true; });
  $('#renameThreadForm').onsubmit = async event => {
    event.preventDefault(); if (saving || !renameThread || composing) return;
    const name = input.value.trim(), thread = renameThread, errorNode = $('#renameThreadError');
    if (!name) { errorNode.textContent = t('Enter a chat name'); errorNode.hidden = false; input.focus(); return; }
    setSaving(true);
    try {
      await rpc('thread/name/set', { threadId: thread.id, name });
      onUpdate(thread.id, { name }); dialog.close(); toast(t('Chat renamed'));
    } catch (error) { errorNode.textContent = errorMessage('Could not rename chat', error); errorNode.hidden = false; }
    finally { setSaving(false); }
  };

  function pinThread(thread) {
    void perform(thread, async () => {
      const result = await rpc('host/thread/pin', { threadId: thread.id, pinned: !thread.pinnedAt });
      onUpdate(thread.id, { pinnedAt: result.pinnedAt });
    }, 'Could not update pin');
  }
  function archiveThread(thread) {
    if (thread.status?.type === 'active') { toast(t('Stop the task before archiving')); return; }
    void perform(thread, async () => {
      await rpc('thread/archive', { threadId: thread.id });
      archiveVersion++; archives = [{ ...thread, pinnedAt: null }, ...archives.filter(item => item.id !== thread.id)];
      onRemove(thread.id); renderArchives(); toast(t('Chat archived'));
    }, 'Could not archive chat');
  }
  function restore(thread) {
    void perform(thread, async () => {
      const result = await rpc('thread/unarchive', { threadId: thread.id });
      archiveVersion++; archives = archives.filter(item => item.id !== thread.id);
      onRestore({ ...thread, ...result.thread, pinnedAt: null }); renderArchives(); toast(t('Chat restored to original project'));
    }, 'Could not restore chat');
  }
  async function remove(thread) {
    if (!thread || pending.has(thread.id)) return;
    if (!await confirmAction({
      title: t('Permanently delete chat'),
      message: t('Delete “{title}”? This permanently deletes this chat and its agent sub-tasks. Independent branches will be kept.', { title: titleOf(thread) }),
      confirmLabel: t('Delete'),
    })) return;
    await perform(thread, async () => {
      const result = await rpc('thread/delete', { threadId: thread.id });
      archiveVersion++; archives = archives.filter(item => item.id !== thread.id); onRemove(thread.id); renderArchives();
      toast(t(result?.attachmentCleanup?.warning ? 'Thread deleted; attachment cleanup was skipped because references could not be verified' : 'Thread deleted'), result?.attachmentCleanup?.warning ? 8000 : 3000);
      if (archiveOpen) void refreshArchives();
    }, 'Could not delete thread');
  }

  async function refreshArchives({ more = false } = {}) {
    if (archiveLoading) return;
    const version = archiveVersion;
    archiveLoading = true; archiveError = false; renderArchives();
    try {
      const result = await rpc('thread/list', { archived: true, limit: 50, sortKey: 'recency_at', sortDirection: 'desc', ...(more && archiveCursor ? { cursor: archiveCursor } : {}) });
      if (version !== archiveVersion) return;
      const incoming = more ? [...archives, ...(result.data || [])] : result.data || [];
      archives = [...new Map(incoming.map(thread => [thread.id, thread])).values()];
      archiveCursor = result.nextCursor || null;
    } catch { archiveError = true; }
    finally { archiveLoading = false; renderArchives(); if (version !== archiveVersion && archiveOpen) void refreshArchives(); }
  }
  function renderArchives(query = $('#threadSearch').value.trim().toLowerCase()) {
    const scrollTop = archiveList.scrollTop;
    archiveButton.setAttribute('aria-expanded', String(archiveOpen)); archiveList.hidden = !archiveOpen;
    archiveList.replaceChildren(); if (!archiveOpen) return;
    for (const thread of archives) {
      if (query && !titleOf(thread).toLowerCase().includes(query) && !thread.cwd?.toLowerCase().includes(query)) continue;
      archiveList.append(createRow(thread, { archived: true }));
    }
    const notice = text => { const node = document.createElement('div'); node.className = 'archive-list-state'; node.textContent = t(text); archiveList.append(node); };
    if (archiveLoading) notice('Loading archived chats…');
    else if (archiveError) {
      notice('Could not load archived chats'); const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'archive-load-more'; retry.innerHTML = codexIcon('refreshCw'); retry.append(document.createTextNode(t('Retry'))); retry.onclick = () => refreshArchives(); archiveList.append(retry);
    } else if (!archiveList.children.length) notice(query ? 'No matching chats' : 'No archived chats');
    if (!archiveLoading && archiveCursor) {
      const more = document.createElement('button'); more.type = 'button'; more.className = 'archive-load-more'; more.innerHTML = codexIcon('chevronDown'); more.append(document.createTextNode(t('Load more'))); more.onclick = () => refreshArchives({ more: true }); archiveList.append(more);
    }
    archiveList.scrollTop = scrollTop;
  }
  archiveButton.onclick = () => { archiveOpen = !archiveOpen; localStorage.setItem('codex-webui-archive-open', String(archiveOpen)); renderArchives(); if (archiveOpen) void refreshArchives(); };
  return {
    createRow, closeMenu,
    beforeRender() { menuAnchor = null; },
    afterRender() { if (menuThread) { syncMenu(); positionMenu(); } renderArchives(); },
    connected() { if (archiveOpen) void refreshArchives(); },
    showArchives() { archiveOpen = true; localStorage.setItem('codex-webui-archive-open', 'true'); renderArchives(); void refreshArchives(); archiveButton.scrollIntoView({ block: 'nearest' }); },
    hasOpenMenu: () => !menu.hidden,
    isRenaming: () => dialog.open,
    notification(method, params) {
      if (method === 'thread/name/updated') { archiveVersion++; for (const thread of archives) if (thread.id === params.threadId) thread.name = params.name; renderArchives(); }
      if ((method === 'thread/archived' || method === 'thread/unarchived') && !pending.has(params.threadId)) { archiveVersion++; if (archiveOpen) void refreshArchives(); }
    },
  };
}
