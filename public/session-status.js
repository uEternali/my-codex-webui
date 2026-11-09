import { codexIcon } from './codex-icons.js';
import { sessionChats } from './session-tree.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const count = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const number = value => value.toLocaleString('en-US');

export function contextUsageValue(tokenUsage) {
  const contextWindow = tokenUsage?.modelContextWindow, totalTokens = tokenUsage?.last?.totalTokens;
  if (!count(contextWindow) || contextWindow <= 0 || !count(totalTokens)) return null;
  return {
    percent: Math.min(totalTokens / contextWindow * 100, 100),
    usedTokens: totalTokens,
    contextWindow,
    remainingTokens: Math.max(contextWindow - totalTokens, 0),
  };
}

function statusLabel({ thread, loading, blocked, running, waitingApproval }) {
  if (loading) return 'Loading chat…';
  if (!thread) return 'New chat';
  if (blocked) return 'Open in another app';
  if (waitingApproval || thread.status?.activeFlags?.includes('waitingOnApproval')) return 'Waiting for approval';
  if (thread.status?.activeFlags?.includes('waitingOnUserInput')) return 'Waiting for input';
  if (running || thread.status?.type === 'active') return 'Working';
  if (thread.status?.type === 'systemError') return 'Session error';
  if (thread.status?.type === 'notLoaded') return 'Not loaded';
  return thread.status?.type === 'idle' ? 'Idle' : 'Status unavailable';
}

export function renderSessionStatus(snapshot, t = (text, values = {}) => text.replace(/\{(\w+)\}/g, (match, key) => values[key] ?? match)) {
  const { thread, usage, permission = {}, cwd, branch, model, effort, connected, transport } = snapshot;
  const unavailable = t('Not available');
  const copyId = (label, value) => value ? `<button type="button" class="icon-button small status-copy" data-status-copy="${escape(value)}" title="${escape(t('Copy {label}', { label: t(label) }))}" aria-label="${escape(t('Copy {label}', { label: t(label) }))}">${codexIcon('copy')}</button>` : '';
  const htmlRow = (label, html, className = '') => `<div class="status-detail"><dt>${escape(t(label))}</dt><dd class="${className}">${html}</dd></div>`;
  const row = (label, value, { id = '', mono = false, copy = false } = {}) => {
    const text = typeof value === 'string' && value ? value : unavailable;
    const copyButton = copy ? copyId(label, value) : '';
    return `<div class="status-detail"><dt>${escape(t(label))}</dt><dd${id ? ` id="${id}"` : ''} class="${mono ? 'status-mono' : ''}"><span>${escape(text)}</span>${copyButton}</dd></div>`;
  };
  const section = (title, content, note = '') => `<section class="summary-section">${title ? `<h2 class="summary-section-title">${escape(t(title))}</h2>` : ''}${note ? `<p class="status-note">${escape(t(note))}</p>` : ''}${content}</section>`;
  const details = content => `<dl class="status-details">${content}</dl>`;
  const related = sessionChats(thread, snapshot.relatedThreads).slice(1);
  const chat = thread?.id ? htmlRow('Chat', `<div class="status-chat-primary"><span>${escape(thread.id)}</span>${related.length ? `<button type="button" class="icon-button small" data-status-toggle-chats aria-expanded="${Boolean(snapshot.chatsExpanded)}" aria-controls="statusRelatedChats" title="${escape(t('Related chats'))}" aria-label="${escape(t('Related chats'))}">${codexIcon('chevronDown', snapshot.chatsExpanded ? 'status-chats-chevron expanded' : 'status-chats-chevron')}</button>` : ''}${copyId('Chat', thread.id)}</div>${related.length ? `<div class="status-related-chats" id="statusRelatedChats"${snapshot.chatsExpanded ? '' : ' hidden'}>${related.map(item => `<div class="status-related-chat"><button type="button" data-status-open-thread="${escape(item.id)}" title="${escape(item.agentNickname || item.agentPath || item.name || t('Open chat'))}">${escape(item.id)}</button>${copyId('Chat', item.id)}</div>`).join('')}</div>` : ''}${snapshot.relatedError ? `<span class="status-note">${escape(t('Could not load related chats'))}</span>` : ''}`, 'status-chat-value status-mono') : row('Chat', null);
  const context = contextUsageValue(usage);
  let contextContent = `<p class="summary-empty">${escape(t(thread ? 'Token usage has not been reported for this chat.' : 'Start a chat to see context usage.'))}</p>`;
  if (context) {
    const used = Math.round(context.percent), remaining = Math.max(100 - used, 0);
    contextContent = `<div class="status-context"><strong>${escape(t('{percent}% left', { percent: remaining }))}</strong><span class="status-context-tokens">${escape(t('(used {used} / total {total})', { used: number(context.usedTokens), total: `${Math.round(context.contextWindow / 1000)}K` }))}</span><div class="status-context-meter" role="progressbar" aria-label="${escape(t('Context usage'))}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${used}"><span style="width:${context.percent}%"></span></div><span class="sr-only">${escape(t('{percent}% used', { percent: used }))}</span></div>`;
  }
  const session = details(row('Session', thread?.sessionId, { mono: true, copy: true }) + chat
    + htmlRow('Background information', contextContent, 'status-context-value') + row('Limits', null));
  const totals = usage?.total;
  const totalRows = [
    ['Input tokens', totals?.inputTokens],
    ['Cached input', totals?.cachedInputTokens],
    ['Output tokens', totals?.outputTokens],
    ['Reasoning tokens', totals?.reasoningOutputTokens],
  ].filter(([, value]) => count(value));
  const chatDetails = details(row('Name', thread ? snapshot.name : t('New chat')) + row('Status', t(statusLabel(snapshot))))
    + (totalRows.length ? `<p class="status-note status-token-note">${escape(t('Cumulative token usage'))}</p>` + details(totalRows.map(([label, value]) => row(label, number(value), { mono: true })).join('')) : '');
  const config = details(
    row('Model', model, { mono: true })
    + row('Reasoning', effort, { mono: true })
    + row('Permissions', permission.label)
    + (permission.kind === 'legacy' ? row('Approval policy', permission.approvalPolicy, { mono: true }) + row('Sandbox', permission.sandbox, { mono: true }) : permission.profileId ? row('Permission profile', permission.profileId, { mono: true }) : ''),
  );
  const environment = details(
    row('Workspace', cwd || (snapshot.projectless ? t('No project') : t('Choose project')), { id: 'summaryWorkspace', mono: Boolean(cwd) })
    + row('Git branch', branch, { id: 'summaryBranch', mono: true })
    + row('Connection', connected ? t('Connected via {transport}', { transport: transport === 'sse' ? 'SSE' : 'WebSocket' }) : t('Reconnecting…')),
  );
  return section('', session) + section('Chat details', chatDetails)
    + section('Runtime configuration', config, 'Applies to your next message.') + section('Environment', environment);
}
