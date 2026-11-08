import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const threadIdPattern = /^[A-Za-z0-9_-]{1,128}$/;
const uploadPattern = /^([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})-.+$/i;
const storeKey = home => createHash('sha256').update(resolve(home)).digest('hex').slice(0, 24);

function atomicJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { writeFileSync(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 }); renameSync(temporary, path); }
  finally { if (existsSync(temporary)) unlinkSync(temporary); }
}
function regularJson(path) {
  if (!lstatSync(path).isFile()) throw new Error('Attachment reference index is not a regular file');
  return JSON.parse(readFileSync(path, 'utf8'));
}
function rolloutFiles(path) {
  if (!existsSync(path)) return [];
  const files = [];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Cannot verify linked session history');
    if (entry.isDirectory()) files.push(...rolloutFiles(child));
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(child);
  }
  return files;
}
async function* jsonLines(path) {
  const stream = createReadStream(path); let pending = [];
  try {
    for await (const chunk of stream) {
      let start = 0, newline;
      while ((newline = chunk.indexOf(10, start)) !== -1) {
        const part = chunk.subarray(start, newline);
        yield (pending.length ? Buffer.concat([...pending, part]) : part).toString('utf8');
        pending = []; start = newline + 1;
      }
      if (start < chunk.length) pending.push(chunk.subarray(start));
    }
    if (pending.length) yield Buffer.concat(pending).toString('utf8');
  } finally { stream.destroy(); }
}

// Upload names stay stable across forks. References live in the shared upload
// directory, namespaced by CODEX_HOME, so dev and production cannot overwrite
// each other's index. Legacy/CLI references are also checked in saved rollouts.
export class AttachmentLifecycle {
  constructor({ directory, codexHome }) {
    this.directory = resolve(directory); this.codexHome = resolve(codexHome);
    this.historyCache = new Map();
    this.references = join(this.directory, '.references');
    this.owner = storeKey(this.codexHome); this.index = join(this.references, this.owner);
    mkdirSync(this.index, { recursive: true, mode: 0o700 });
    this.canonicalRoot = realpathSync(this.directory);
    this.checkIndex();
    atomicJson(join(this.index, 'store.json'), { codexHome: this.codexHome });
  }
  checkIndex() {
    if (realpathSync(this.references) !== join(this.canonicalRoot, '.references') || realpathSync(this.index) !== join(this.canonicalRoot, '.references', this.owner)) throw new Error('Attachment index is outside uploads');
  }
  files() {
    if (realpathSync(this.directory) !== this.canonicalRoot) throw new Error('Upload directory changed');
    const files = [];
    for (const name of readdirSync(this.directory)) {
      const match = uploadPattern.exec(name); if (!match) continue;
      const path = join(this.directory, name), stat = lstatSync(path);
      if (stat.isFile()) files.push({ name, id: match[1], path, ino: stat.ino, dev: stat.dev });
    }
    return files;
  }
  findReferences(value, files) {
    const text = typeof value === 'string' ? value : JSON.stringify(value) || '';
    return files.filter(file => text.includes(file.id)).map(file => file.name);
  }
  record(threadId, value, forkedFromId = null) {
    this.checkIndex();
    if (!threadIdPattern.test(threadId || '')) throw new Error('Invalid attachment thread id');
    const path = join(this.index, `${threadId}.json`);
    const previous = existsSync(path) ? regularJson(path) : {};
    const files = new Set([...(previous.files || []), ...this.findReferences(value, this.files())]);
    if (forkedFromId && threadIdPattern.test(forkedFromId)) {
      const parent = join(this.index, `${forkedFromId}.json`);
      if (existsSync(parent)) for (const name of regularJson(parent).files || []) files.add(name);
    }
    // Older indexes called fork ancestry parentThreadId. It is reference
    // inheritance, never ownership: deleting a source must preserve its forks.
    const source = forkedFromId || previous.forkedFromId || previous.parentThreadId || null;
    const spawnedParentThreadId = value?.parentThreadId || previous.spawnedParentThreadId || null;
    if (files.size || source || spawnedParentThreadId) atomicJson(path, { threadId, forkedFromId: source, spawnedParentThreadId, files: [...files] });
  }
  stores() {
    this.checkIndex();
    return readdirSync(this.references, { withFileTypes: true }).map(entry => {
      if (!entry.isDirectory() || !/^[a-f0-9]{24}$/.test(entry.name)) throw new Error('Cannot verify attachment reference store');
      const index = join(this.references, entry.name), store = regularJson(join(index, 'store.json'));
      if (typeof store.codexHome !== 'string' || !existsSync(store.codexHome) || storeKey(store.codexHome) !== entry.name) throw new Error('Cannot verify Codex history location');
      const records = readdirSync(index).filter(name => name !== 'store.json' && name.endsWith('.json')).map(name => {
        const record = regularJson(join(index, name));
        if (!threadIdPattern.test(record.threadId || '') || name !== `${record.threadId}.json` || !Array.isArray(record.files)) throw new Error('Invalid attachment reference record');
        return record;
      });
      return { owner: entry.name, ...store, index, records };
    });
  }
  async history(store, files, excluded = new Set()) {
    const histories = [];
    for (const area of ['sessions', 'archived_sessions']) {
      for (const path of rolloutFiles(join(store.codexHome, area))) {
        const before = statSync(path), signature = `${before.dev}:${before.ino}:${before.size}:${before.mtimeMs}:${before.ctimeMs}`;
        const cached = this.historyCache.get(path);
        if (cached?.signature === signature) {
          if (!excluded.has(cached.threadId)) histories.push({ threadId: cached.threadId, spawnedParentThreadId: cached.spawnedParentThreadId, files: files.filter(file => cached.ids.has(file.id)).map(file => file.name) });
          continue;
        }
        const attachmentIds = new Set(); let id = null, spawnedParentThreadId = null;
          for await (const line of jsonLines(path)) {
            if (!line.trim()) continue;
            const event = JSON.parse(line);
            if (event.type === 'session_meta') { id = event.payload?.id; spawnedParentThreadId = event.payload?.source?.subagent?.thread_spawn?.parent_thread_id || null; }
            for (const match of line.matchAll(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi)) attachmentIds.add(match[0]);
          }
        const after = statSync(path);
        if (!threadIdPattern.test(id || '') || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('Session history changed; attachment cleanup skipped');
        this.historyCache.set(path, { signature, threadId: id, spawnedParentThreadId, ids: attachmentIds });
        if (!excluded.has(id)) histories.push({ threadId: id, spawnedParentThreadId, files: files.filter(file => attachmentIds.has(file.id)).map(file => file.name) });
      }
    }
    return histories;
  }
  async prepareDelete(threadId, thread) {
    if (!threadIdPattern.test(threadId || '')) throw new Error('Invalid attachment thread id');
    const files = this.files();
    if (!files.length) return { threadIds: [threadId], files: [] };
    const own = this.stores().find(store => store.owner === this.owner);
    const records = [...own.records, ...await this.history(own, files)];
    const ids = new Set([threadId]); let changed;
    do { changed = false; for (const record of records) if (ids.has(record.spawnedParentThreadId) && !ids.has(record.threadId)) { ids.add(record.threadId); changed = true; } } while (changed);
    const names = new Set(this.findReferences(thread, files));
    for (const record of records) if (ids.has(record.threadId)) for (const name of record.files) names.add(name);
    return { threadIds: [...ids], files: files.filter(file => names.has(file.name)) };
  }
  async cleanupDeleted(plan) {
    // Called only after native deletion succeeded. Never sweep unrelated drafts
    // or arbitrary workspace files, and retain data if any history is unreadable.
    if (!plan) return { deleted: 0, retained: 0, warning: true };
    this.checkIndex();
    const ids = new Set(plan.threadIds);
    for (const id of ids) {
      if (!threadIdPattern.test(id || '')) throw new Error('Invalid attachment thread id');
      const path = join(this.index, `${id}.json`); if (existsSync(path)) unlinkSync(path);
    }
    if (!plan.files.length) return { deleted: 0, retained: 0, warning: false };
    const referenced = new Set();
    for (const store of this.stores()) {
      const excluded = store.owner === this.owner ? ids : new Set();
      for (const record of await this.history(store, plan.files, excluded)) for (const name of record.files) referenced.add(name);
    }
    // Read indexes last: inputs are registered before a turn is sent to Codex,
    // including turns whose rollout has not been written yet.
    for (const store of this.stores()) for (const record of store.records) {
      if (store.owner === this.owner && ids.has(record.threadId)) continue;
      for (const name of record.files) referenced.add(name);
    }
    let deleted = 0, retained = 0;
    const directory = realpathSync(this.directory);
    if (directory !== this.canonicalRoot) throw new Error('Upload directory changed');
    for (const file of plan.files) {
      if (!uploadPattern.test(file.name) || /[/\\]/.test(file.name)) throw new Error('Invalid upload filename');
      if (referenced.has(file.name)) { retained++; continue; }
      const path = join(directory, file.name);
      if (!existsSync(path)) continue;
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.ino !== file.ino || stat.dev !== file.dev) { retained++; continue; }
      unlinkSync(path); deleted++;
    }
    return { deleted, retained, warning: false };
  }
}
