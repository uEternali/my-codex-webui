import { codexIcon } from './codex-icons.js';
import { GoalStore, goalPresentation, parseGoalCommand } from './goal-state.js';

export function createGoalController({ rpc, getThread, ensureThread, translate = value => value, onModeChange = () => {}, root = document, refreshInterval = 10_000, now = Date.now }) {
  const $ = selector => root.querySelector(selector), t = translate, store = new GoalStore();
  const picker = $('#goalPicker'), button = $('#goalButton'), menu = $('#goalMenu');
  const dialog = $('#goalDialog'), form = $('#goalForm'), objective = $('#goalObjective');
  const error = $('#goalError'), dialogError = $('#goalDialogError');
  let selectedId = null, selection = 0, editorThreadId = null, busy = false, readId = 0, pendingRead = null;
  let lastReadAt = -Infinity;
  const goal = () => store.get(selectedId);
  const setText = (node, value) => { if (node.textContent !== value) node.textContent = value; };
  const closeMenu = () => { menu.hidden = true; button.setAttribute('aria-expanded', 'false'); };
  const showError = (message, inDialog = false) => {
    const target = inDialog ? dialogError : error;
    setText(target, t(message || 'Could not update goal')); target.hidden = false;
  };
  const clearErrors = () => { error.hidden = true; dialogError.hidden = true; };
  const closeEditor = () => { dialog.close(); onModeChange(false); };

  function render() {
    const current = goal(); picker.hidden = !current;
    if (!current) { closeMenu(); return; }
    const presentation = goalPresentation(current);
    picker.dataset.goalStatus = current.status;
    $('#goalStatusIcon').innerHTML = codexIcon(presentation.icon);
    setText($('#goalStatusLabel'), t(presentation.label));
    setText($('#goalObjectivePreview'), current.objective);
    button.title = `${t(presentation.label)}: ${current.objective}`;
    button.disabled = busy;
    setText($('#goalMenuObjective'), current.objective);
    $('#goalPause').hidden = !presentation.canPause;
    $('#goalResume').hidden = !presentation.canResume;
    for (const action of menu.querySelectorAll('button')) action.disabled = busy;
  }

  async function refresh({ force = false } = {}) {
    const threadId = selectedId;
    if (!threadId || busy || (pendingRead?.threadId === threadId && pendingRead.generation === selection)) return;
    if (!force && now() - lastReadAt < refreshInterval) return;
    lastReadAt = now();
    const request = ++readId, generation = selection, revision = store.revision(threadId);
    pendingRead = { threadId, generation, request };
    try {
      const result = await rpc('thread/goal/get', { threadId });
      if (request !== readId || generation !== selection || threadId !== selectedId) return;
      if (store.read(threadId, revision, result.goal || null)) { error.hidden = true; render(); }
    } catch (failure) {
      // Keep the last known goal during transient disconnects. Mutations report errors.
      if (!failure?.silentTransportSwitch && request === readId && generation === selection) {
        showError(failure.message || 'Could not load goal');
      }
    } finally {
      if (pendingRead?.request === request) pendingRead = null;
    }
  }

  function selectThread(threadId, { preserveEditor = false } = {}) {
    if (threadId === selectedId) return;
    selectedId = threadId || null; selection++; readId++; lastReadAt = -Infinity; clearErrors(); closeMenu();
    if (dialog.open && !preserveEditor) closeEditor();
    if (preserveEditor) editorThreadId = selectedId;
    render();
    if (selectedId) void refresh();
  }

  function notification(method, params) {
    if (method !== 'thread/goal/updated' && method !== 'thread/goal/cleared') return;
    if (store.set(params.threadId, method === 'thread/goal/cleared' ? null : params.goal)) {
      if (params.threadId === selectedId) { clearErrors(); render(); }
    }
  }

  function openEditor() {
    if (busy) return;
    clearErrors(); closeMenu(); editorThreadId = selectedId;
    objective.value = goal()?.objective || '';
    $('#goalDialogTitle').textContent = t(goal() ? 'Edit goal' : 'Set goal');
    $('#goalSave').textContent = t(goal() ? 'Save goal' : 'Start goal');
    onModeChange(true); dialog.showModal(); objective.focus();
  }

  async function mutate(action, value) {
    if (busy) return false;
    const generation = selection, initialThreadId = selectedId;
    busy = true; clearErrors(); closeMenu(); render();
    for (const control of form.elements) control.disabled = true;
    try {
      if (action === 'set' && (!value?.trim() || value.trim().length > 4000)) throw new Error('Enter a goal of 1–4,000 characters');
      if (action !== 'set') {
        const current = goal();
        if (!current) throw new Error('No goal set for this task');
        if (action === 'pause' && !goalPresentation(current).canPause) throw new Error('Only an active goal can be paused');
        if (action === 'resume' && !goalPresentation(current).canResume) throw new Error('Only a paused goal can be resumed');
      }
      const thread = await ensureThread();
      // Do not apply a delayed action to a different task selected in the meantime.
      if (!thread || thread.id !== getThread()?.id || (initialThreadId && (generation !== selection || initialThreadId !== selectedId))) throw new Error('Task changed. Try again in the selected task.');
      const threadId = thread.id, revision = store.revision(threadId);
      let result;
      if (action === 'clear') {
        result = await rpc('thread/goal/clear', { threadId, origin: 'user' });
        // clear also succeeds when another client has already removed the goal.
        if (store.revision(threadId) === revision) store.set(threadId, null);
      } else {
        const params = { threadId, origin: 'user' };
        if (action === 'set') {
          params.objective = value.trim();
          params.status = store.get(threadId)?.status === 'paused' ? 'paused' : 'active';
        } else params.status = action === 'pause' ? 'paused' : 'active';
        result = await rpc('thread/goal/set', params);
        if (!result.goal) throw new Error('Codex did not return a goal');
        if (store.revision(threadId) === revision) store.set(threadId, result.goal);
      }
      if (dialog.open && editorThreadId === threadId) closeEditor();
      return true;
    } catch (failure) {
      if (!failure?.silentTransportSwitch && selectedId === (getThread()?.id || null)) showError(failure.message || 'Could not update goal', dialog.open);
      return false;
    } finally {
      busy = false;
      for (const control of form.elements) control.disabled = false;
      render();
    }
  }

  async function command(text) {
    const parsed = parseGoalCommand(text);
    if (!parsed) return null;
    if (busy) return { accepted: false };
    if (parsed.action === 'view') { openEditor(); return { accepted: true }; }
    return { accepted: await mutate(parsed.action, parsed.objective) };
  }

  button.onclick = () => {
    const open = menu.hidden; closeMenu();
    if (open) { menu.hidden = false; button.setAttribute('aria-expanded', 'true'); menu.querySelector('button:not([hidden])')?.focus(); }
  };
  $('#goalEdit').onclick = openEditor;
  $('#goalPause').onclick = () => void mutate('pause');
  $('#goalResume').onclick = () => void mutate('resume');
  $('#goalDelete').onclick = () => void mutate('clear');
  $('#goalCancel').onclick = closeEditor;
  form.onsubmit = event => { event.preventDefault(); if (editorThreadId !== selectedId) return; void mutate('set', objective.value); };
  dialog.addEventListener('close', () => onModeChange(false));
  dialog.addEventListener('click', event => { if (event.target === dialog && !busy) closeEditor(); });
  root.addEventListener('click', event => { if (!event.composedPath().includes(picker)) closeMenu(); });
  root.addEventListener('keydown', event => {
    if (menu.hidden) return;
    if (event.key === 'Escape') { event.preventDefault(); closeMenu(); button.focus(); return; }
    if (!menu.contains(event.target) || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const actions = [...menu.querySelectorAll('button:not([hidden]):not(:disabled)')], index = actions.indexOf(root.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? actions.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + actions.length) % actions.length;
    actions[next]?.focus();
  });
  return { selectThread, refresh, notification, openEditor, command, render };
}
