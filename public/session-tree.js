const sourceKinds = ['cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview', 'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown'];
const recency = thread => Number(thread.recencyAt || thread.updatedAt || thread.createdAt) || 0;

export function parentThreadId(thread) {
  return thread?.parentThreadId || thread?.source?.subAgent?.thread_spawn?.parent_thread_id || thread?.source?.subagent?.thread_spawn?.parent_thread_id || null;
}

// A saved fork may start its own session. Never infer membership from
// forkedFromId, a filename, or the fact that two chats share a workspace.
export function sessionChats(thread, threads = []) {
  if (!thread?.id) return [];
  const all = new Map(threads.filter(item => item?.id).map(item => [item.id, item]));
  all.set(thread.id, { ...all.get(thread.id), ...thread });
  const byId = new Map([...all].filter(([, item]) => thread.sessionId && item.sessionId === thread.sessionId));
  byId.set(thread.id, all.get(thread.id));
  // Native child sessions can have their own sessionId. Explicit parent edges
  // establish membership; forkedFromId never does.
  let parent = parentThreadId(thread); const seen = new Set([thread.id]);
  while (parent && all.has(parent) && !seen.has(parent)) {
    seen.add(parent); byId.set(parent, all.get(parent)); parent = parentThreadId(all.get(parent));
  }
  const children = new Map();
  for (const item of all.values()) {
    const parent = parentThreadId(item); if (!parent) continue;
    if (!children.has(parent)) children.set(parent, []); children.get(parent).push(item);
  }
  const queue = [...byId.keys()];
  for (let index = 0; index < queue.length; index++)
    for (const child of children.get(queue[index]) || [])
      if (!byId.has(child.id)) { byId.set(child.id, child); queue.push(child.id); }
  return [byId.get(thread.id), ...[...byId.values()].filter(item => item.id !== thread.id).sort((a, b) => recency(b) - recency(a))];
}

export function subagentThreads(threads, parentId) {
  if (!parentId) return [];
  const levels = new Map([[parentId, 0]]), children = [];
  const remaining = new Map(threads.filter(thread => thread?.id && thread.id !== parentId).map(thread => [thread.id, thread]));
  while (remaining.size) {
    let added = false;
    for (const [id, thread] of remaining) {
      const parent = parentThreadId(thread);
      if (!levels.has(parent)) continue;
      const depth = levels.get(parent) + 1;
      levels.set(id, depth); children.push({ ...thread, depth }); remaining.delete(id); added = true;
    }
    if (!added) break; // Missing parents or malformed cycles are not guessed.
  }
  return children.sort((a, b) => a.depth - b.depth || recency(b) - recency(a));
}

export function createSessionTree({ rpc, onChange = () => {}, now = Date.now, ttl = 10000 }) {
  let entry = { key: null, threads: [], loading: false, error: '', at: -Infinity }, generation = 0, pending = null;
  function snapshot(thread, known = []) {
    const key = thread?.sessionId || thread?.id || null;
    if (entry.key !== key) {
      generation += 1; pending = null;
      entry = { key, threads: [], loading: false, error: '', at: -Infinity };
    }
    const related = sessionChats(thread, known);
    const byId = new Map(entry.threads.map(item => [item.id, item]));
    for (const item of related) byId.set(item.id, { ...byId.get(item.id), ...item });
    entry.threads = [...byId.values()];
    return { ...entry };
  }
  async function refresh(thread, known = [], force = false) {
    snapshot(thread, known);
    if (!entry.key) return;
    if (pending) return pending;
    if (!force && now() - entry.at < ttl) return;
    const request = generation, root = entry.key;
    entry.loading = true; entry.error = '';
    const work = async () => {
      try {
        const data = [], seen = new Set(); let cursor;
        do {
          const result = await rpc('thread/list', { ancestorThreadId: root, sourceKinds, modelProviders: [], limit: 100, sortKey: 'recency_at', sortDirection: 'desc', ...(cursor ? { cursor } : {}) });
          if (request !== generation) return;
          data.push(...result.data || []); cursor = result.nextCursor;
          if (cursor && seen.has(cursor)) throw new Error('Could not load all related chats');
          if (cursor) seen.add(cursor);
        } while (cursor);
        if (root !== thread.id && !entry.threads.some(item => item.id === root)) {
          try { const result = await rpc('thread/read', { threadId: root, includeTurns: false }); if (result.thread) data.push(result.thread); }
          catch { /* A removed root must not hide its surviving descendants. */ }
        }
        if (request !== generation) return;
        const descendants = subagentThreads(data, root);
        // Reconcile against the fresh listing so externally deleted children
        // do not survive in the panel's cache forever.
        const roots = entry.threads.filter(item => !parentThreadId(item));
        const verified = new Map(sessionChats(thread, [...roots, ...data]).map(item => [item.id, item]));
        for (const item of descendants) verified.set(item.id, item);
        entry.threads = [...verified.values()];
      } catch (error) {
        if (request === generation) entry.error = error?.message || 'Could not load related chats';
      } finally {
        if (request === generation) { entry.loading = false; entry.at = now(); pending = null; onChange(); }
      }
    };
    pending = Promise.resolve().then(work); return pending;
  }
  function notification(method, params) {
    if (!entry.key) return;
    if (method === 'thread/started') {
      const thread = params.thread;
      if (thread?.sessionId === entry.key || entry.threads.some(item => item.id === parentThreadId(thread))) {
        entry.threads = [...entry.threads.filter(item => item.id !== thread.id), thread]; entry.at = -Infinity;
      }
    } else if (method === 'thread/deleted') entry.threads = entry.threads.filter(thread => thread.id !== params.threadId);
    else if (method === 'thread/status/changed' || method === 'thread/name/updated') {
      entry.threads = entry.threads.map(thread => thread.id === params.threadId ? { ...thread, ...(method === 'thread/status/changed' ? { status: params.status } : { name: params.name }) } : thread);
    }
  }
  return { snapshot, refresh, notification };
}
