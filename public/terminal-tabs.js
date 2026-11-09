import { codexIcon } from './codex-icons.js';

export function createTerminalTabs({ tabList, hosts, getCwd, createState, initialize, dispose, onActive = () => {}, onEmpty = () => {}, t = text => text }) {
  const entries = new Map(); let sequence = 0, active = null;
  function localize() {
    for (const entry of entries.values()) {
      entry.tab.textContent = `${t('Terminal')} ${entry.number}`;
      entry.close.title = t('Close terminal {number}', { number: entry.number });
      entry.close.setAttribute('aria-label', entry.close.title);
    }
  }
  function select(id) {
    const entry = entries.get(id); if (!entry) return;
    active = id;
    for (const item of entries.values()) {
      const selected = item.id === id;
      item.host.hidden = !selected; item.wrapper.classList.toggle('active', selected);
      item.tab.setAttribute('aria-selected', String(selected)); item.tab.tabIndex = selected ? 0 : -1;
    }
    onActive(entry.state); initialize(entry.state);
    entry.tab.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }
  function add() {
    const number = ++sequence, id = `terminal-${number}`, document = hosts.ownerDocument;
    const host = document.createElement('div'); host.className = 'terminal-host'; host.id = number === 1 ? 'terminalHost' : `terminalHost-${number}`; host.dataset.connected = 'false'; host.setAttribute('role', 'tabpanel');
    const state = createState(host.id, 'bottomPanel'); state.cwd = getCwd();
    const wrapper = document.createElement('div'); wrapper.className = 'bottom-terminal-tab'; wrapper.dataset.terminalId = id; wrapper.title = state.cwd;
    const tab = document.createElement('button'); tab.type = 'button'; tab.className = 'bottom-panel-tab'; tab.id = number === 1 ? 'bottomPanelTab' : `bottomPanelTab-${number}`; tab.setAttribute('role', 'tab'); tab.setAttribute('aria-controls', host.id); host.setAttribute('aria-labelledby', tab.id);
    const close = document.createElement('button'); close.type = 'button'; close.className = 'icon-button small bottom-terminal-close'; close.innerHTML = codexIcon('x'); close.dataset.closeTerminal = id;
    wrapper.append(tab, close); hosts.append(host); tabList.append(wrapper);
    entries.set(id, { id, number, state, host, wrapper, tab, close }); localize();
    tab.onclick = () => select(id); close.onclick = () => remove(id);
    select(id); return state;
  }
  function remove(id) {
    const entry = entries.get(id); if (!entry) return;
    const ids = [...entries.keys()], index = ids.indexOf(id), wasActive = active === id;
    dispose(entry.state); entry.host.remove(); entry.wrapper.remove(); entries.delete(id);
    if (!entries.size) { active = null; onActive(null); onEmpty(); }
    else if (wasActive) select(ids[index + 1] || ids[index - 1]);
  }
  tabList.addEventListener('keydown', event => {
    if (!event.target.matches('[role=tab]') || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const ids = [...entries.keys()], index = ids.indexOf(active);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? ids.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + ids.length) % ids.length;
    select(ids[next]); entries.get(ids[next]).tab.focus();
  });
  return { add, select, remove, localize, open() { if (active) select(active); else add(); }, values: () => [...entries.values()].map(entry => entry.state), get active() { return entries.get(active)?.state || null; } };
}
