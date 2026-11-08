// Goal state is owned by Codex app-server, including continuation and accounting.
export function parseGoalCommand(text) {
  const match = /^\/goal(?:\s+([\s\S]*))?$/i.exec(String(text).trim());
  if (!match) return null;
  const value = (match[1] || '').trim();
  if (!value) return { action: 'view' };
  if (['pause', 'resume', 'clear'].includes(value.toLowerCase())) return { action: value.toLowerCase() };
  return { action: 'set', objective: value };
}

export function goalPresentation(goal) {
  const statuses = {
    active: ['Pursuing goal', 'loaderCircle'],
    paused: ['Goal paused', 'square'],
    blocked: ['Goal stalled', 'triangleAlert'],
    usageLimited: ['Goal hit usage limits', 'triangleAlert'],
    budgetLimited: ['Goal unmet', 'triangleAlert'],
    complete: ['Goal achieved', 'check'],
  };
  const [label, icon] = statuses[goal?.status] || ['Goal unavailable', 'triangleAlert'];
  return { label, icon, canPause: goal?.status === 'active', canResume: goal?.status === 'paused' };
}

// A notification or mutation received while a read is in flight wins over that read.
export class GoalStore {
  entries = new Map();
  get(threadId) { return this.entries.get(threadId)?.goal || null; }
  revision(threadId) { return this.entries.get(threadId)?.revision || 0; }
  set(threadId, goal) {
    if (!threadId || (goal && goal.threadId !== threadId)) return false;
    this.entries.set(threadId, { goal, revision: this.revision(threadId) + 1 });
    return true;
  }
  read(threadId, revision, goal) {
    if (revision !== this.revision(threadId)) return false;
    return this.set(threadId, goal);
  }
}
