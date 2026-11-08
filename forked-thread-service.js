import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// Paginated native forks can be absent from thread/list until their first new
// user message. Remember only their IDs and a short label; history stays native.
export class ForkedThreadIndex {
  constructor(path) {
    this.path = path;
    this.entries = new Map();
    this.cache = new Map();
    try {
      for (const entry of JSON.parse(readFileSync(path, 'utf8')).entries || []) {
        if (typeof entry.id === 'string' && typeof entry.preview === 'string') this.entries.set(entry.id, entry);
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }

  save() {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ version: 1, entries: [...this.entries.values()] }), { mode: 0o600 });
    renameSync(temporary, this.path);
  }

  remember(thread) {
    if (!thread?.id || thread.ephemeral) return thread;
    const user = (thread.turns || []).flatMap(turn => turn.items || []).find(item => item.type === 'userMessage');
    const preview = (thread.preview || (user?.content || []).map(part => part.text || '').join('\n')).slice(0, 200);
    this.entries.set(thread.id, { id: thread.id, preview });
    this.save();
    return { ...thread, preview: thread.preview || preview };
  }

  forget(id) {
    this.cache.delete(id);
    if (this.entries.delete(id)) this.save();
  }

  invalidate(id) { this.cache.delete(id); }

  setArchived(id, archived) {
    this.invalidate(id);
    const entry = this.entries.get(id);
    if (entry) { entry.archived = archived; this.save(); }
  }

  async merge(result, params, read) {
    // Augment the WebUI's ordinary first page; native filtered/paginated queries
    // retain their own filtering contract.
    if (!Array.isArray(result?.data) || params.cursor ||
      ['cwd', 'searchTerm', 'parentThreadId', 'ancestorThreadId', 'attachedToThreadId', 'sectionId', 'projectId'].some(key => params[key] != null) ||
      ['modelProviders', 'sourceKinds', 'excludedThreadIds', 'originators'].some(key => params[key]?.length)) return result;
    const present = new Set(result.data.map(thread => thread.id));
    const additional = await Promise.all([...this.entries.values()].filter(entry => Boolean(entry.archived) === Boolean(params.archived) && !present.has(entry.id)).map(async entry => {
      const cached = this.cache.get(entry.id);
      if (cached && Date.now() - cached.at < 15000) return cached.thread;
      try {
        const { thread } = await read(entry.id);
        if (!thread || thread.id !== entry.id || thread.ephemeral) return null;
        const summary = { ...thread, preview: thread.preview || entry.preview, turns: [] };
        this.cache.set(entry.id, { at: Date.now(), thread: summary });
        return summary;
      } catch (error) {
        if (/thread (?:not found|does not exist)|no such thread/i.test(error.message || '')) this.forget(entry.id);
        return null;
      }
    }));
    const recency = params.sortKey === 'recency_at' || params.sortKey === 'updated_at';
    const time = thread => recency ? thread.recencyAt ?? thread.updatedAt ?? thread.createdAt ?? 0 : thread.createdAt ?? 0;
    const direction = params.sortDirection === 'asc' ? 1 : -1;
    const data = [...result.data, ...additional.filter(Boolean)].sort((a, b) => direction * (time(a) - time(b)));
    // The native cursor already accounts for every native row in this page.
    // Extra summaries must not displace rows that later pages will skip.
    return { ...result, data };
  }
}
