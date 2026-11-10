import { agentMessageText, renderAssistantMarkdown, renderItemImages } from './rendering.js';
import { renderUserAttachments, userMessageContent } from './user-attachments.js';
import { summarizeActivity, unifiedDiffFromFileChanges } from './codex-surfaces.js';
import { settleActivityItem } from './turn-status.js';
import { isBridgeConnectionError } from './bridge-rpc.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const textParts = parts => (Array.isArray(parts) ? parts : []).map(part => typeof part === 'string' ? part : part?.text || '').filter(Boolean).join('\n');

export function renderSubagentTurns(turns, { cwd = '', t = text => text } = {}) {
  return turns.map(turn => `<section class="subagent-turn" data-preview-turn="${escape(turn.id)}">${(turn.items || []).map(original => {
    const item = settleActivityItem(original, turn.status);
    if (item.type === 'userMessage') {
      const { text, attachments } = userMessageContent(item);
      return `<div class="subagent-user">${renderUserAttachments(attachments, { cwd, translate: t })}${text ? `<div class="user-message">${escape(text)}</div>` : ''}</div>`;
    }
    if (item.type === 'agentMessage') return `<div class="message-text" data-i18n-ignore>${renderAssistantMarkdown(agentMessageText(item), { cwd })}${renderItemImages(item, { cwd })}</div>`;
    if (item.type === 'reasoning') {
      const text = textParts(item.summary) || textParts(item.content);
      return text ? `<details class="subagent-activity" data-preview-item="${escape(item.id)}"><summary>${escape(t('Thinking'))}</summary><div class="message-text" data-i18n-ignore>${renderAssistantMarkdown(text, { cwd })}</div></details>` : '';
    }
    const activity = summarizeActivity(item), diff = item.type === 'fileChange' ? unifiedDiffFromFileChanges(item.changes || []) : '';
    const output = [activity.detail, diff, item.aggregatedOutput].filter(Boolean).join('\n');
    return `<details class="subagent-activity${activity.active ? ' active' : ''}" data-preview-item="${escape(item.id)}"><summary>${escape(t(activity.label || item.type))}</summary>${output ? `<pre data-i18n-ignore>${escape(output)}</pre>` : ''}</details>`;
  }).join('')}${turn.error?.message ? `<p class="subagent-error">${escape(turn.error.message)}</p>` : ''}</section>`).join('');
}

export function createSubagentPreview({ rpc, root, getOwnerId, isVisible, onOpenChat, t, interval = 2400 }) {
  const content = root.querySelector('[data-subagent-content]'), notice = root.querySelector('[data-subagent-notice]'), earlier = root.querySelector('[data-subagent-earlier]');
  let selected = null, owner = null, generation = 0, timer = null, pending = false, turns = [], cursor = null, markup = '', firstPageLoaded = false, revision = null;
  const current = request => request === generation && owner === getOwnerId() && selected;
  function render() {
    const next = renderSubagentTurns(turns, { cwd: selected?.cwd, t }) || `<p class="side-task-empty">${escape(t('No subagent messages yet.'))}</p>`;
    if (next !== markup) {
      const atBottom = content.scrollHeight - content.clientHeight - content.scrollTop < 60;
      const expanded = new Set([...content.querySelectorAll('details[open][data-preview-item]')].map(node => node.dataset.previewItem));
      content.innerHTML = next; markup = next;
      for (const node of content.querySelectorAll('details[data-preview-item]')) node.open = expanded.has(node.dataset.previewItem);
      if (atBottom) content.scrollTop = content.scrollHeight;
    }
    earlier.hidden = !cursor;
  }
  function suspend() { clearTimeout(timer); timer = null; }
  function close() {
    suspend(); generation += 1; selected = null; owner = null; pending = false; turns = []; markup = ''; cursor = null; firstPageLoaded = false; revision = null;
    root.hidden = true; root.removeAttribute('aria-busy');
  }
  async function refresh(older = false) {
    suspend();
    if (!selected || owner !== getOwnerId()) { close(); return; }
    if (pending || !isVisible()) return;
    const request = generation, id = selected.id;
    pending = true; earlier.disabled = true;
    try {
      let live = null;
      if (!older) {
        try { live = await rpc('host/thread/live', { threadId: id, ...(revision ? { sinceRevision: revision } : {}) }); }
        catch (error) { if (isBridgeConnectionError(error)) throw error; }
        if (!current(request)) return;
        if (revision && live?.unchanged && live.revision === revision) { notice.hidden = true; return; }
      }
      const threadResult = await rpc('thread/read', { threadId: id, includeTurns: false });
      if (!current(request)) return;
      if (threadResult.thread?.id !== id) throw new Error('Subagent chat not found');
      selected = { ...selected, ...threadResult.thread };
      const result = await rpc('thread/turns/list', { threadId: id, limit: 20, sortDirection: 'desc', itemsView: 'full', ...(older && cursor ? { cursor } : {}) });
      if (!current(request)) return;
      const page = [...result.data || []].reverse();
      const byId = new Map((older ? [...page, ...turns] : [...turns, ...page]).map(turn => [turn.id, turn]));
      turns = [...byId.values()];
      if (older || !firstPageLoaded) cursor = result.nextCursor || null;
      firstPageLoaded = true;
      if (!older) {
        if (live?.active && live.turn) {
          const index = turns.findIndex(turn => turn.id === live.turn.id), stored = turns[index];
          const items = [...stored?.items || []];
          for (const item of live.turn.items || []) {
            const at = items.findIndex(existing => existing.id === item.id || existing.type === item.type && item.type === 'agentMessage' && agentMessageText(existing) === agentMessageText(item));
            if (at < 0) items.push(item); else items[at] = item;
          }
          const turn = { ...stored, ...live.turn, items };
          if (index < 0) turns.push(turn); else turns[index] = turn;
        }
      }
      notice.hidden = true; render();
      if (!older) revision = typeof live?.revision === 'string' ? live.revision : null;
    } catch (error) {
      if (current(request)) { notice.hidden = false; notice.querySelector('span').textContent = error?.message || t('Could not load subagent messages'); }
    } finally {
      if (current(request)) {
        pending = false; earlier.disabled = false; root.removeAttribute('aria-busy');
        if (isVisible()) timer = setTimeout(() => void refresh(), interval);
      }
    }
  }
  function open(thread) {
    close(); selected = thread; owner = getOwnerId(); root.hidden = false;
    root.setAttribute('aria-busy', 'true'); notice.hidden = true; earlier.hidden = true;
    root.querySelector('[data-subagent-title]').textContent = thread.agentNickname || thread.agentPath || thread.name || thread.model || t('Subagent');
    root.querySelector('[data-subagent-id]').textContent = thread.id;
    content.innerHTML = `<p class="side-task-empty">${escape(t('Loading chat…'))}</p>`;
    void refresh();
  }
  root.querySelector('[data-subagent-open]').onclick = () => selected && onOpenChat(selected);
  root.querySelector('[data-subagent-retry]').onclick = () => void refresh();
  earlier.onclick = () => void refresh(true);
  return { open, close, suspend, refresh, localize() { if (selected) render(); }, syncOwner() { if (selected && owner !== getOwnerId()) close(); }, get selected() { return selected; } };
}
