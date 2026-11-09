export const SIDEBAR_PAGE_SIZE = 5;

export function threadRecency(thread) {
  return Number(thread.recencyAt || thread.updatedAt || thread.createdAt) || 0;
}

export async function loadSidebarThreads(rpc) {
  const threads = new Map(), seen = new Set();
  let cursor;
  do {
    const result = await rpc('thread/list', { limit: 100, sortKey: 'recency_at', sortDirection: 'desc', ...(cursor ? { cursor } : {}) });
    for (const thread of result.data || []) threads.set(thread.id, thread);
    cursor = result.nextCursor;
    if (cursor && seen.has(cursor)) throw new Error('Could not load the complete chat list');
    if (cursor) seen.add(cursor);
  } while (cursor);
  return { data: [...threads.values()].sort((a, b) => threadRecency(b) - threadRecency(a)) };
}
