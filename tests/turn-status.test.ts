import { afterEach, describe, expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { formatWorkedDuration, initializeTurnPresentation, settleActivityItem, showTurnError, updateTurnPresentation } from '../public/turn-status.js';

const windows: JSDOM[] = [];
function fixture(final = false) {
  const dom = new JSDOM('<article><div class="turn-event-stream"></div><div class="turn-final-slot"></div></article>');
  windows.push(dom);
  const turn = dom.window.document.querySelector('article')!;
  initializeTurnPresentation(turn);
  if (final) turn.querySelector('.turn-final-slot')!.innerHTML = '<div data-local-conversation-final-assistant>Answer</div>';
  return {
    turn,
    status: turn.querySelector<HTMLElement>('[data-turn-live-status]')!,
    footer: turn.querySelector<HTMLElement>('[data-worked-for-divider]')!,
    time: turn.querySelector<HTMLTimeElement>('time')!,
    error: turn.querySelector<HTMLElement>('[data-turn-error]')!,
  };
}
afterEach(() => { for (const dom of windows.splice(0)) dom.window.close(); });

describe('unfinished activity in a terminal turn', () => {
  test('stops unfinished tools without changing their output or the input snapshot', () => {
    for (const status of ['interrupted', 'cancelled', 'canceled']) {
      const item = { id: 'command', type: 'commandExecution', status: 'inProgress', command: 'curl example.test', aggregatedOutput: 'partial output' };
      expect(settleActivityItem(item, status)).toEqual({ ...item, status: 'interrupted' });
      expect(item.status).toBe('inProgress');
    }
  });

  test('settles failed and completed turns, including alternate live item statuses', () => {
    for (const status of ['inProgress', 'running', 'pendingInit']) {
      const item = { type: 'reasoning', status, summary: ['Partial reasoning'] };
      expect(settleActivityItem(item, 'completed').status).toBe('completed');
      expect(settleActivityItem(item, 'failed').status).toBe('failed');
    }
  });

  test('retains completed results and leaves tools active while their turn is active', () => {
    for (const status of ['completed', 'failed', 'declined', 'interrupted']) {
      const item = { type: 'commandExecution', status, exitCode: 6, aggregatedOutput: 'Could not resolve host' };
      expect(settleActivityItem(item, 'interrupted')).toBe(item);
    }
    const pending = { type: 'commandExecution', status: 'inProgress' };
    expect(settleActivityItem(pending, 'inProgress')).toBe(pending);
    expect(settleActivityItem(pending)).toBe(pending);
  });
});

describe('turn status and completion footer', () => {
  test('acknowledged turns show progress before any reasoning or output arrives', () => {
    const { turn, status, footer } = fixture();
    updateTurnPresentation(turn, { status: 'inProgress' }, { live: true, now: 10_000 });
    expect(status.hidden).toBe(false);
    expect(status.textContent).toBe('Working');
    expect(turn.getAttribute('aria-busy')).toBe('true');
    expect(footer.hidden).toBe(true);
  });

  test('avoids duplicate progress beside an active tool, then resumes the fallback', () => {
    const { turn, status } = fixture();
    updateTurnPresentation(turn, { status: 'inProgress' }, { hasActiveActivity: true });
    expect(status.hidden).toBe(true);
    updateTurnPresentation(turn);
    expect(status.hidden).toBe(false);
  });

  test('plain replies show elapsed time and a completion timestamp below the final answer', () => {
    const { turn, status, footer, time } = fixture(true);
    updateTurnPresentation(turn, { status: 'completed', startedAt: 100, completedAt: 145 });
    expect(footer.hidden).toBe(false);
    expect(footer.querySelector('[data-worked-for-label]')!.textContent).toBe('Worked for 45s');
    expect(turn.lastElementChild).toBe(footer);
    expect(time.dateTime).toBe('1970-01-01T00:02:25.000Z');
    expect(time.textContent).toMatch(/^\d{2}:\d{2}$/);
    expect(status.hidden).toBe(true);
    expect(turn.getAttribute('aria-busy')).toBe('false');
  });

  test('honors millisecond timestamps and explicit server duration', () => {
    const { turn, footer, time } = fixture(true);
    updateTurnPresentation(turn, { status: 'completed', startedAtMs: 100_000, completedAtMs: 160_000, durationMs: 45_000 });
    expect(footer.querySelector('[data-worked-for-label]')!.textContent).toBe('Worked for 45s');
    expect(time.dateTime).toBe('1970-01-01T00:02:40.000Z');
  });

  test('retains the original completion time across later snapshots', () => {
    const { turn, footer, time } = fixture(true);
    updateTurnPresentation(turn, { status: 'inProgress' }, { live: true, now: 100_000 });
    expect(footer.hidden).toBe(true);
    updateTurnPresentation(turn, { status: 'completed' }, { live: true, now: 145_000 });
    updateTurnPresentation(turn, { status: 'completed' }, { live: true, now: 300_000 });
    expect(time.dateTime).toBe('1970-01-01T00:02:25.000Z');
    expect(footer.querySelector('[data-worked-for-label]')!.textContent).toBe('Worked for 45s');
  });

  test('does not invent a completion timestamp for historical turns missing metadata', () => {
    const { turn, time } = fixture(true);
    updateTurnPresentation(turn, { status: 'completed' }, { now: 300_000 });
    expect(time.hidden).toBe(true);
  });

  test('ignores a delayed start after completion', () => {
    const { turn, status, footer } = fixture(true);
    updateTurnPresentation(turn, { status: 'completed', completedAt: 145 });
    updateTurnPresentation(turn, { status: 'inProgress' }, { live: true });
    expect(status.hidden).toBe(true);
    expect(footer.hidden).toBe(false);
    expect(turn.getAttribute('aria-busy')).toBe('false');
  });

  test('interruption stops the shimmer and leaves a stopped status', () => {
    const { turn, status, footer } = fixture();
    updateTurnPresentation(turn, { status: 'inProgress' });
    updateTurnPresentation(turn, { status: 'interrupted' });
    expect(status.hidden).toBe(false);
    expect(status.textContent).toBe('Stopped');
    expect(status.classList.contains('loading-shimmer')).toBe(false);
    expect(footer.hidden).toBe(true);
  });

  test('formats short and long durations without NaN or negative values', () => {
    expect(formatWorkedDuration(300)).toBe('1s');
    expect(formatWorkedDuration(128_000)).toBe('2m 8s');
    expect(formatWorkedDuration(120_000)).toBe('2m');
    expect(formatWorkedDuration(-1)).toBeNull();
    expect(formatWorkedDuration(undefined)).toBeNull();
  });
});

describe('inline request errors and retries', () => {
  test('failed snapshots render structured HTTP 503 errors in the conversation', () => {
    const { turn, error, status } = fixture();
    updateTurnPresentation(turn, { status: 'failed', error: { message: 'Service unavailable', codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 503 } }, additionalDetails: 'Please try again later.' } });
    expect(error.hidden).toBe(false);
    expect(error.getAttribute('role')).toBe('alert');
    expect(error.textContent).toContain('HTTP 503: Service unavailable');
    expect(error.textContent).toContain('Please try again later.');
    expect(status.hidden).toBe(true);
    expect(turn.getAttribute('aria-busy')).toBe('false');
  });

  test('retry notifications update one notice, preserving the upstream n/N and details', () => {
    const { turn, error } = fixture(true);
    updateTurnPresentation(turn, { status: 'inProgress' });
    showTurnError(turn, { message: 'Reconnecting... 1/5', additionalDetails: 'HTTP 503: upstream unavailable' }, { willRetry: true });
    showTurnError(turn, { message: 'Reconnecting... 2/5', additionalDetails: 'HTTP 503: upstream unavailable' }, { willRetry: true });
    updateTurnPresentation(turn);
    expect(turn.querySelectorAll('[data-turn-error]').length).toBe(1);
    expect(error.textContent).toContain('Retrying request (2)');
    expect(error.textContent).toContain('Reconnecting... 2/5');
    expect(error.textContent).toContain('HTTP 503');
    expect(turn.getAttribute('aria-busy')).toBe('true');
    updateTurnPresentation(turn, { status: 'completed', completedAt: 145 });
    expect(error.hidden).toBe(true);
  });

  test('a failed turn after retrying retains the error as a terminal failure', () => {
    const { turn, error } = fixture();
    showTurnError(turn, 'HTTP 503: max retries reached', { willRetry: true });
    updateTurnPresentation(turn, { status: 'failed' });
    expect(error.hidden).toBe(false);
    expect(error.querySelector('[data-turn-error-title]')!.textContent).toBe('Request failed');
    expect(error.textContent).toContain('HTTP 503: max retries reached');
    expect(turn.getAttribute('aria-busy')).toBe('false');
  });

  test('does not invent a retry limit and treats error messages as plain text', () => {
    const { turn, error } = fixture();
    showTurnError(turn, '<img src=x onerror=alert(1)> HTTP 429', { willRetry: true });
    expect(error.querySelector('[data-turn-error-title]')!.textContent).toBe('Retrying request (1)');
    expect(error.textContent).not.toContain('/5');
    expect(error.textContent).toContain('<img src=x');
    expect(error.querySelector('img')).toBeNull();
  });
});
