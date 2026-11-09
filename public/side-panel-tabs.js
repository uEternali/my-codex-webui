import { codexIcon } from './codex-icons.js';

const titles = { launcher: 'New tab', review: 'Review', terminal: 'Terminal', browser: 'Browser', files: 'Files', 'side-task': 'Subagents', 'side-chat': 'Side chat' };

export function createSidePanelTabs({ list, onSelect, beforeRemove = () => true, onRemove = () => {}, onEmpty = () => {}, t = text => text }) {
  const entries = new Map(); let sequence = 0, active = null;
  function localize() {
    for (const entry of entries.values()) {
      entry.button.textContent = t(titles[entry.kind]);
      entry.close.title = t('Close tab'); entry.close.setAttribute('aria-label', entry.close.title);
      entry.button.dataset.sidePanelTab = entry.kind;
    }
  }
  function select(id) {
    const entry = entries.get(id); if (!entry) return;
    const previous = entries.get(active); active = id;
    for (const item of entries.values()) {
      const selected = item === entry;
      item.wrapper.classList.toggle('active', selected);
      item.button.classList.toggle('active', selected); item.button.tabIndex = selected ? 0 : -1;
      item.button.setAttribute('aria-selected', String(selected));
    }
    onSelect(entry, previous); entry.wrapper.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    return entry;
  }
  function launcher() {
    const existing = [...entries.values()].find(entry => entry.kind === 'launcher');
    if (existing) return select(existing.id);
    const id = `side-tab-${++sequence}`, doc = list.ownerDocument;
    const wrapper = doc.createElement('div'); wrapper.className = 'side-panel-tab-wrapper';
    const button = doc.createElement('button'); button.type = 'button'; button.className = 'side-panel-tab'; button.id = id; button.setAttribute('role', 'tab');
    const close = doc.createElement('button'); close.type = 'button'; close.className = 'icon-button small side-panel-tab-close'; close.innerHTML = codexIcon('x'); close.dataset.closeSideTab = id;
    wrapper.append(button, close); list.append(wrapper);
    entries.set(id, { id, kind: 'launcher', button, close, wrapper });
    button.onclick = () => select(id); close.onclick = () => remove(id);
    localize(); return select(id);
  }
  function choose(kind) {
    if (!titles[kind] || kind === 'launcher') return;
    if (kind === 'files' || kind === 'side-task' || kind === 'side-chat') {
      const existing = [...entries.values()].find(entry => entry.kind === kind);
      if (existing) return select(existing.id);
    }
    const entry = entries.get(active)?.kind === 'launcher' ? entries.get(active) : launcher();
    entry.kind = kind; localize(); return select(entry.id);
  }
  function open(kind) {
    const existing = [...entries.values()].find(entry => entry.kind === kind);
    return existing ? select(existing.id) : choose(kind);
  }
  function remove(id) {
    const entry = entries.get(id); if (!entry) return;
    if (entry.removal) return entry.removal;
    const allowed = beforeRemove(entry);
    if (allowed?.then) {
      entry.close.disabled = true;
      entry.removal = Promise.resolve(allowed).then(result => result !== false && finishRemove(id)).finally(() => { entry.removal = null; entry.close.disabled = false; });
      return entry.removal;
    }
    return allowed !== false && finishRemove(id);
  }
  function finishRemove(id) {
    const entry = entries.get(id); if (!entry) return false;
    const ids = [...entries.keys()], index = ids.indexOf(id), selected = active === id;
    entries.delete(id); entry.wrapper.remove(); onRemove(entry);
    if (!entries.size) { active = null; onEmpty(); }
    else if (selected) select(ids[index + 1] || ids[index - 1]);
    return true;
  }
  list.addEventListener('keydown', event => {
    if (event.target.getAttribute('role') !== 'tab') return;
    if (event.key === 'Delete') { event.preventDefault(); remove(active); entries.get(active)?.button.focus(); return; }
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); const ids = [...entries.keys()], index = ids.indexOf(active);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? ids.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + ids.length) % ids.length;
    select(ids[next]); entries.get(active)?.button.focus();
  });
  return { launcher, choose, open, select, remove, localize, values: () => [...entries.values()], get active() { return entries.get(active) || null; } };
}
