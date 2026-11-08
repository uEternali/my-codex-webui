import { codexIcon } from './codex-icons.js';

// Projects are groups of native sessions with the same workspace, not folders
// owned by the WebUI. Batch actions only use the session APIs.
export function createProjectControls({ rpc, translate: t, projectKeyFor, projectName, getThreads, onNew, onRemove, onRefresh, onProjectEmpty, closeThreadMenu, toast }) {
  const menu = document.querySelector('#projectActionsMenu');
  let selected = null, anchor = null, busy = false;

  function closeMenu(returnFocus = true) {
    const previous = anchor; previous?.setAttribute('aria-expanded', 'false');
    selected = null; anchor = null; menu.hidden = true;
    if (returnFocus && previous?.isConnected) previous.focus();
  }
  function positionMenu() {
    if (!anchor?.isConnected) { closeMenu(false); return; }
    const rect = anchor.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(rect.right - menu.offsetWidth, innerWidth - menu.offsetWidth - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(rect.bottom + 5, innerHeight - menu.offsetHeight - 8))}px`;
  }
  function createActions(key) {
    const actions = document.createElement('span'); actions.className = 'sidebar-project-actions';
    for (const [icon, label, className, click] of [
      ['squarePen', 'New chat in “{project}”', 'project-new-chat', () => { closeMenu(false); onNew(key); }],
      ['ellipsis', 'More actions for “{project}”', 'project-more', node => {
        if (selected === key) { closeMenu(); return; }
        closeMenu(false); closeThreadMenu(); selected = key; anchor = node; menu.hidden = false;
        node.setAttribute('aria-expanded', 'true'); positionMenu(); menu.querySelector('button')?.focus();
      }],
    ]) {
      const button = document.createElement('button'); button.type = 'button'; button.className = `thread-action ${className}`;
      button.title = t(label, { project: projectName(key) }); button.setAttribute('aria-label', button.title);
      button.disabled = busy; button.innerHTML = codexIcon(icon);
      if (className === 'project-more') {
        button.setAttribute('aria-haspopup', 'menu'); button.setAttribute('aria-controls', menu.id);
        button.setAttribute('aria-expanded', String(selected === key)); if (selected === key) anchor = button;
      }
      button.onclick = event => { event.stopPropagation(); click(button); };
      actions.append(button);
    }
    return actions;
  }

  async function listAll(archived) {
    const params = { archived, limit: 100, sortKey: 'created_at', sortDirection: 'asc' };
    const threads = new Map(), cursors = new Set(); let cursor = null;
    do {
      const result = await rpc('thread/list', { ...params, ...(cursor ? { cursor } : {}) });
      for (const thread of result.data || []) threads.set(thread.id, thread);
      cursor = result.nextCursor || null;
      if (cursor && cursors.has(cursor)) throw new Error(t('Could not load the complete chat list'));
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return [...threads.values()];
  }
  const parentId = thread => thread.parentThreadId;
  const running = thread => thread?.status?.type === 'active' || thread?.turns?.some(turn => turn.status === 'inProgress');
  async function perform(key, action) {
    if (busy) return;
    busy = true; let completed = 0, total = 0, cleanupSkipped = false;
    const failure = action === 'archive' ? 'Could not archive project' : 'Could not delete project';
    onRefresh(false); toast(t('Loading project chats…'), 60000);
    try {
      const active = await listAll(false), archived = action === 'delete' ? await listAll(true) : [];
      const all = [...active, ...archived], byId = new Map(all.map(thread => [thread.id, thread]));
      const ids = new Set(all.filter(thread => projectKeyFor(thread) === key).map(thread => thread.id));
      // Native deletion cascades only to spawned subagents, not ordinary forks.
      // Include agents in confirmation/running checks, and delete leaves first.
      if (action === 'delete') {
        let changed;
        do { changed = false; for (const thread of all) if (ids.has(parentId(thread)) && !ids.has(thread.id)) { ids.add(thread.id); changed = true; } } while (changed);
      }
      const targets = all.filter(thread => ids.has(thread.id)); total = targets.length;
      if (!total) { onProjectEmpty(key); toast(t('No chats in this project')); return; }
      const live = new Map(getThreads().map(thread => [thread.id, thread]));
      if (targets.some(thread => running(thread) || running(live.get(thread.id)))) { toast(t('Stop running tasks in this project first'), 5200); return; }
      const message = action === 'archive'
        ? 'Archive “{project}” and all {count} chats? Workspace files will be kept. Restoring a chat will show its original project again.'
        : 'Delete “{project}” and all {count} chats, including archived chats and agent sub-tasks? This cannot be undone. Workspace files and independent branches in other projects will be kept.';
      if (!confirm(t(message, { project: projectName(key), count: total }))) { toast(t('Canceled')); return; }
      const depth = thread => { let result = 0, parent = parentId(thread); const seen = new Set([thread.id]); while (byId.has(parent) && !seen.has(parent)) { seen.add(parent); result++; parent = parentId(byId.get(parent)); } return result; };
      if (action === 'delete') targets.sort((a, b) => depth(b) - depth(a));
      for (const thread of targets) {
        const result = await rpc('thread/read', { threadId: thread.id, includeTurns: false });
        if (!result.thread || running(result.thread) || running(getThreads().find(item => item.id === thread.id))) throw new Error(t('Stop running tasks in this project first'));
        const mutation = await rpc(`thread/${action}`, { threadId: thread.id });
        cleanupSkipped ||= Boolean(mutation?.attachmentCleanup?.warning);
        completed++; onRemove(thread.id);
        toast(t('Processing project chats: {done}/{total}', { done: completed, total }), 60000);
      }
      onProjectEmpty(key);
      const success = t(action === 'archive' ? 'Project archived ({count} chats)' : 'Project deleted ({count} chats)', { count: completed });
      toast(cleanupSkipped ? `${success} · ${t('Some attachment cleanup was skipped because references could not be verified')}` : success, cleanupSkipped ? 8000 : 5200);
    } catch (error) {
      toast(`${t(failure)} (${completed}/${total})${error?.message ? `: ${error.message}` : ''}`, 8000);
    } finally { busy = false; onRefresh(true); }
  }
  for (const button of menu.querySelectorAll('[data-project-action]')) button.onclick = () => {
    const key = selected, action = button.dataset.projectAction; closeMenu(false); if (key) void perform(key, action);
  };
  menu.onkeydown = event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeMenu(); return; }
    const buttons = [...menu.querySelectorAll('button:not(:disabled)')], index = buttons.indexOf(document.activeElement);
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length; buttons[next]?.focus();
    } else if (event.key === 'Tab') closeMenu(false);
  };
  document.addEventListener('pointerdown', event => { if (!menu.hidden && !menu.contains(event.target) && !anchor?.contains(event.target)) closeMenu(false); });
  document.addEventListener('scroll', event => { if (!menu.hidden && !menu.contains(event.target)) closeMenu(false); }, true);
  addEventListener('resize', () => closeMenu(false));
  return { createActions, closeMenu, hasOpenMenu: () => !menu.hidden, beforeRender() { anchor = null; }, afterRender() { if (selected) positionMenu(); } };
}
