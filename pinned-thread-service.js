import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// WebUI presentation preferences; names, history and archives stay in Codex.
export class PinnedThreadStore {
  constructor(path) {
    this.path = path;
    this.pins = new Map();
    try {
      for (const entry of JSON.parse(readFileSync(path, 'utf8')).pins || []) {
        if (typeof entry.id === 'string' && Number.isFinite(entry.pinnedAt) && entry.pinnedAt > 0) this.pins.set(entry.id, entry.pinnedAt);
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }

  set(id, pinned) {
    if (typeof id !== 'string' || !id.trim() || typeof pinned !== 'boolean') throw new Error('Invalid pin request');
    const pinnedAt = pinned ? this.pins.get(id) || Date.now() : null;
    if (pinned) this.pins.set(id, pinnedAt); else this.pins.delete(id);
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ version: 1, pins: [...this.pins].map(([id, pinnedAt]) => ({ id, pinnedAt })) }), { mode: 0o600 });
    renameSync(temporary, this.path);
    return { threadId: id, pinnedAt };
  }

  forget(id) { if (this.pins.has(id)) this.set(id, false); }

  async merge(result, params, read) {
    if (!Array.isArray(result?.data)) return result;
    const ordinary = !params.cursor && !params.archived &&
      !['cwd', 'searchTerm', 'parentThreadId', 'ancestorThreadId', 'attachedToThreadId', 'sectionId', 'projectId'].some(key => params[key] != null) &&
      !['modelProviders', 'sourceKinds', 'excludedThreadIds', 'originators'].some(key => params[key]?.length);
    const data = result.data.map(thread => ({ ...thread, pinnedAt: params.archived ? null : this.pins.get(thread.id) || null }));
    if (!ordinary) return { ...result, data };
    const present = new Set(data.map(thread => thread.id));
    const missing = await Promise.all([...this.pins].filter(([id]) => !present.has(id)).map(async ([id, pinnedAt]) => {
      try {
        const { thread } = await read(id);
        if (!thread || thread.ephemeral || /[/\\]archived_sessions[/\\]/.test(thread.path || '')) { this.forget(id); return null; }
        return { ...thread, turns: [], pinnedAt };
      } catch (error) {
        if (/thread (?:not found|does not exist)|no such thread/i.test(error.message || '')) this.forget(id);
        return null;
      }
    }));
    data.push(...missing.filter(Boolean));
    data.sort((a, b) => (b.pinnedAt || 0) - (a.pinnedAt || 0));
    // The native cursor already accounts for every native row in this page.
    // Extra summaries must not displace rows that later pages will skip.
    return { ...result, data };
  }
}
