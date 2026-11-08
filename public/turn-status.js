import { codexIcon } from './codex-icons.js';

const terminalStatuses = new Set(['completed', 'failed', 'interrupted', 'cancelled', 'canceled']);

export function settleActivityItem(item, turnStatus) {
  if (!terminalStatuses.has(turnStatus) || !['inProgress', 'running', 'pendingInit'].includes(item.status)) return item;
  // Interrupted turns do not always emit item/completed for every tool. Keep the
  // recorded output, but never let those unfinished items remain animated.
  const status = ['interrupted', 'cancelled', 'canceled'].includes(turnStatus) ? 'interrupted' : turnStatus;
  return { ...item, status };
}

export function initializeTurnPresentation(timeline) {
  timeline.insertAdjacentHTML('beforeend', `<div class="turn-live-status loading-shimmer" data-turn-live-status role="status" aria-live="polite" hidden>Working</div><div class="turn-request-error" data-turn-error role="alert" hidden><strong data-turn-error-title></strong><div data-turn-error-message data-i18n-ignore></div></div><div class="worked-for-divider" data-worked-for-divider hidden><span class="reply-actions"><button type="button" class="reply-action" data-copy-reply title="Copy reply" aria-label="Copy reply">${codexIcon('copy')}</button><button type="button" class="reply-action" data-fork-reply title="Branch from here" aria-label="Branch from here">${codexIcon('gitBranch')}</button></span><span data-worked-for-label>Worked</span><span data-worked-for-separator aria-hidden="true" hidden>•</span><time hidden></time></div>`);
  return timeline.querySelector('[data-worked-for-divider]');
}

export function formatWorkedDuration(durationMs) {
  if (!Number.isFinite(durationMs) || durationMs < 0) return null;
  const seconds = Math.max(1, Math.round(durationMs / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60), rest = seconds % 60;
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
}

function timestampMs(turn, name) {
  if (Number.isFinite(turn[`${name}Ms`])) return turn[`${name}Ms`];
  return Number.isFinite(turn[name]) ? turn[name] * 1000 : undefined;
}

function httpStatus(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 3) return null;
  for (const key of ['httpStatusCode', 'statusCode', 'http_status_code', 'status']) {
    const code = value[key];
    if (code != null && /^\d{3}$/.test(String(code)) && Number(code) >= 400 && Number(code) <= 599) return String(code);
  }
  for (const key of ['codexErrorInfo', 'httpConnectionFailed', 'response', 'error']) {
    const code = httpStatus(value[key], depth + 1);
    if (code) return code;
  }
  return null;
}

export function turnErrorMessage(error) {
  const message = typeof error === 'string' ? error : error?.message || 'Codex request failed';
  const code = httpStatus(error);
  const detail = typeof error?.additionalDetails === 'string' ? error.additionalDetails : '';
  return `${code && !String(message).includes(code) ? `HTTP ${code}: ` : ''}${message}${detail && detail !== message ? `\n${detail}` : ''}`;
}

export function showTurnError(timeline, error, { willRetry = false } = {}) {
  const notice = timeline.querySelector('[data-turn-error]');
  notice.hidden = false;
  notice.dataset.retrying = String(willRetry);
  // Count only retry notifications actually received; the upstream's own n/N remains in its message.
  if (willRetry) notice.dataset.retryCount = String(Number(notice.dataset.retryCount || 0) + 1);
  notice.querySelector('[data-turn-error-title]').textContent = willRetry ? `Retrying request (${notice.dataset.retryCount})` : 'Request failed';
  notice.querySelector('[data-turn-error-message]').textContent = turnErrorMessage(error);
}

export function updateTurnPresentation(timeline, turn = {}, { live = false, hasActiveActivity = false, now = Date.now() } = {}) {
  const data = timeline.dataset;
  // Delayed start responses or snapshots must not resurrect an already finished turn.
  if (!(terminalStatuses.has(data.turnStatus) && turn.status === 'inProgress') && turn.status) data.turnStatus = turn.status;
  const active = data.turnStatus === 'inProgress';
  const started = timestampMs(turn, 'startedAt'), completed = timestampMs(turn, 'completedAt');
  if (Number.isFinite(started)) data.startedAtMs = String(started);
  else if (live && active && !data.startedAtMs) data.startedAtMs = String(now);
  if (Number.isFinite(completed)) data.completedAtMs = String(completed);
  else if (live && terminalStatuses.has(data.turnStatus) && !data.completedAtMs) data.completedAtMs = String(now);
  if (Number.isFinite(turn.durationMs) && turn.durationMs >= 0) data.durationMs = String(turn.durationMs);
  else if (data.startedAtMs && data.completedAtMs) data.durationMs = String(Math.max(0, Number(data.completedAtMs) - Number(data.startedAtMs)));

  const notice = timeline.querySelector('[data-turn-error]');
  if (turn.error || turn.failure || data.turnStatus === 'failed' && (notice.hidden || notice.dataset.retrying === 'true')) showTurnError(timeline, turn.error || turn.failure || notice.querySelector('[data-turn-error-message]').textContent || 'Codex request failed');
  if (data.turnStatus === 'completed' && notice.dataset.retrying === 'true') notice.hidden = true;
  timeline.setAttribute('aria-busy', String(active));
  const stopped = ['interrupted', 'cancelled', 'canceled'].includes(data.turnStatus), status = timeline.querySelector('[data-turn-live-status]');
  status.textContent = stopped ? 'Stopped' : 'Working';
  status.classList.toggle('loading-shimmer', active);
  status.hidden = !(active || stopped) || hasActiveActivity && active || !notice.hidden;

  const footer = timeline.querySelector('[data-worked-for-divider]');
  footer.hidden = data.turnStatus !== 'completed' || !timeline.querySelector('[data-local-conversation-final-assistant]');
  const duration = formatWorkedDuration(data.durationMs === undefined ? undefined : Number(data.durationMs));
  footer.querySelector('[data-worked-for-label]').textContent = duration ? `Worked for ${duration}` : 'Worked';
  const time = footer.querySelector('time'), date = data.completedAtMs ? new Date(Number(data.completedAtMs)) : null;
  time.hidden = !date || !Number.isFinite(date.getTime());
  footer.querySelector('[data-worked-for-separator]').hidden = time.hidden;
  if (!time.hidden) {
    time.dateTime = date.toISOString();
    time.textContent = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    time.title = date.toLocaleString();
  }
  return active;
}
