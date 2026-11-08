import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AttachmentLifecycle } from '../attachment-lifecycle-service.js';
import { storeAttachment } from '../attachment-service.js';

const temporary: string[] = [];
afterEach(() => { for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'webui-attachment-lifecycle-')); temporary.push(root);
  const directory = join(root, 'uploads'), home = join(root, 'dev'), prodHome = join(root, 'prod');
  mkdirSync(home); mkdirSync(prodHome);
  const dev = new AttachmentLifecycle({ directory, codexHome: home });
  const prod = new AttachmentLifecycle({ directory, codexHome: prodHome });
  const upload = () => storeAttachment(Buffer.from('attachment content'), { filename: '文件.txt', directory });
  const input = file => [{ type: 'text', text: `Attached file: ${file.name}\nServer path: ${file.path}\nRead this file as needed for this request.` }];
  const history = (where, id, value, { archived = false, parent = null, fork = null } = {}) => {
    const area = join(where, archived ? 'archived_sessions' : 'sessions'); mkdirSync(area, { recursive: true });
    const path = join(area, `${id}.jsonl`);
    writeFileSync(path, [JSON.stringify({ type: 'session_meta', payload: { id, forked_from_id: fork, source: parent ? { subagent: { thread_spawn: { parent_thread_id: parent } } } : 'cli' } }), JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: value } })].join('\n') + '\n');
    return path;
  };
  return { root, directory, home, prodHome, dev, prod, upload, input, history };
}
describe('session-owned attachment cleanup', () => {
  test('deletes an exclusive attachment after successful native deletion; preserves unrelated drafts', async () => {
    const f = fixture(), file = f.upload(), draft = f.upload();
    f.dev.record('original', f.input(file));
    const plan = await f.dev.prepareDelete('original', {});
    expect(existsSync(file.path)).toBe(true);
    expect(await f.dev.cleanupDeleted(plan)).toEqual({ deleted: 1, retained: 0, warning: false });
    expect(existsSync(file.path)).toBe(false); expect(existsSync(draft.path)).toBe(true);
  });
  test('keeps attachments referenced by another pending turn, then deletes after its last session is deleted', async () => {
    const f = fixture(), file = f.upload();
    f.dev.record('first', f.input(file)); f.dev.record('second', [{ type: 'localImage', path: file.path }]);
    expect((await f.dev.cleanupDeleted(await f.dev.prepareDelete('first', {}))).retained).toBe(1);
    expect(existsSync(file.path)).toBe(true);
    expect((await f.dev.cleanupDeleted(await f.dev.prepareDelete('second', {}))).deleted).toBe(1);
  });
  test('namespaces references from dev and production in the shared directory', async () => {
    const f = fixture(), file = f.upload(); f.dev.record('same-id', f.input(file)); f.prod.record('same-id', f.input(file));
    expect((await f.dev.cleanupDeleted(await f.dev.prepareDelete('same-id', {}))).retained).toBe(1);
    expect((await f.prod.cleanupDeleted(await f.prod.prepareDelete('same-id', {}))).deleted).toBe(1);
  });
  test('protects legacy references in production and archived history, including through old directory aliases', async () => {
    const f = fixture(), file = f.upload(), alias = join(f.root, 'old-uploads'); symlinkSync(f.directory, alias);
    f.dev.record('dev-chat', f.input(file));
    const saved = f.history(f.prodHome, 'prod-chat', f.input({ ...file, path: join(alias, file.path.split('/').at(-1)) }), { archived: true });
    expect((await f.dev.cleanupDeleted(await f.dev.prepareDelete('dev-chat', {}))).retained).toBe(1);
    const plan = await f.prod.prepareDelete('prod-chat', {}); rmSync(saved);
    expect((await f.prod.cleanupDeleted(plan)).deleted).toBe(1);
  });
  test('finds historical ordinary-file references without a preexisting index', async () => {
    const f = fixture(), file = f.upload(), saved = f.history(f.home, 'legacy', f.input(file));
    const plan = await f.dev.prepareDelete('legacy', {}); rmSync(saved);
    expect((await f.dev.cleanupDeleted(plan)).deleted).toBe(1);
  });
  test('includes spawned agent descendants and their exclusive attachments', async () => {
    const f = fixture(), parentFile = f.upload(), childFile = f.upload();
    const p = f.history(f.home, 'parent', f.input(parentFile));
    const c = f.history(f.home, 'child', f.input(childFile), { archived: true, parent: 'parent' });
    const plan = await f.dev.prepareDelete('parent', {}); expect(plan.threadIds.sort()).toEqual(['child', 'parent']);
    rmSync(p); rmSync(c); expect((await f.dev.cleanupDeleted(plan)).deleted).toBe(2);
  });
  test('retains inherited references for a fork not yet written to a rollout', async () => {
    const f = fixture(), file = f.upload(); f.dev.record('parent', f.input(file)); f.dev.record('fork', {}, 'parent');
    const plan = await f.dev.prepareDelete('fork', {});
    expect(plan.files).toHaveLength(1);
    expect((await f.dev.cleanupDeleted(plan)).retained).toBe(1);
    expect((await f.dev.cleanupDeleted(await f.dev.prepareDelete('parent', {}))).deleted).toBe(1);
  });
  test('deleting the source preserves an independent fork and its inherited attachment', async () => {
    const f = fixture(), file = f.upload(); f.dev.record('parent', f.input(file)); f.dev.record('fork', {}, 'parent');
    const plan = await f.dev.prepareDelete('parent', {});
    expect(plan.threadIds).toEqual(['parent']);
    expect((await f.dev.cleanupDeleted(plan)).retained).toBe(1);
    expect(existsSync(join(f.dev.index, 'fork.json'))).toBe(true); expect(existsSync(file.path)).toBe(true);
    expect((await f.dev.cleanupDeleted(await f.dev.prepareDelete('fork', {}))).deleted).toBe(1);
  });
  test('legacy fork indexes and saved fork histories are never treated as owned subagents', async () => {
    const f = fixture(), file = f.upload(); f.dev.record('parent', f.input(file));
    writeFileSync(join(f.dev.index, 'fork.json'), JSON.stringify({ threadId: 'fork', parentThreadId: 'parent', files: [file.path.split('/').at(-1)] }));
    const saved = f.history(f.home, 'saved-fork', f.input(file), { fork: 'parent', archived: true });
    const plan = await f.dev.prepareDelete('parent', {}); expect(plan.threadIds).toEqual(['parent']);
    expect((await f.dev.cleanupDeleted(plan)).retained).toBe(1);
    expect((await f.dev.cleanupDeleted(await f.dev.prepareDelete('fork', {}))).retained).toBe(1);
    const last = await f.dev.prepareDelete('saved-fork', {}); rmSync(saved);
    expect((await f.dev.cleanupDeleted(last)).deleted).toBe(1);
  });
  test('fails closed when another store history is malformed or an index is corrupted', async () => {
    const f = fixture(), file = f.upload(); f.dev.record('source', f.input(file));
    const plan = await f.dev.prepareDelete('source', {}), saved = f.history(f.prodHome, 'bad-history', []);
    writeFileSync(saved, readFileSync(saved, 'utf8') + '{partially written');
    await expect(f.dev.cleanupDeleted(plan)).rejects.toThrow(); expect(existsSync(file.path)).toBe(true);
    rmSync(saved); writeFileSync(join(f.prod.index, 'corrupt.json'), 'not json');
    await expect(f.dev.cleanupDeleted(plan)).rejects.toThrow(); expect(existsSync(file.path)).toBe(true);
  });
  test('never removes workspace files, symlink targets, or files replaced during cleanup', async () => {
    const f = fixture(), external = join(f.root, 'important.txt'); writeFileSync(external, 'keep');
    const file = f.upload(); f.dev.record('owner', f.input(file)); const plan = await f.dev.prepareDelete('owner', {});
    rmSync(file.path); symlinkSync(external, file.path);
    expect((await f.dev.cleanupDeleted(plan)).retained).toBe(1); expect(readFileSync(external, 'utf8')).toBe('keep');
    expect(f.dev.files()).toHaveLength(0);
    expect(() => f.dev.record('../../outside', [])).toThrow();
  });
  test('a cancelled or failed native deletion does not remove files or references', async () => {
    const f = fixture(), file = f.upload(); f.dev.record('keep', f.input(file));
    await f.dev.prepareDelete('keep', {});
    expect(existsSync(file.path)).toBe(true); expect(existsSync(join(f.dev.index, 'keep.json'))).toBe(true);
  });
  test('invalidates a cached history when another environment adds an attachment reference', async () => {
    const f = fixture(), file = f.upload(); f.dev.record('owner', f.input(file));
    f.history(f.prodHome, 'other', []);
    const store = f.dev.stores().find(store => store.owner === f.prod.owner);
    await f.dev.history(store, f.dev.files());
    f.history(f.prodHome, 'other', f.input(file));
    expect((await f.dev.cleanupDeleted(await f.dev.prepareDelete('owner', {}))).retained).toBe(1);
  });
  test('refuses to follow a reference-index symlink outside uploads', async () => {
    const f = fixture(), file = f.upload(); f.dev.record('owner', f.input(file));
    const plan = await f.dev.prepareDelete('owner', {}), outside = join(f.root, 'project'); mkdirSync(outside);
    writeFileSync(join(outside, 'owner.json'), 'project data');
    renameSync(f.dev.index, f.dev.index + '-saved'); symlinkSync(outside, f.dev.index);
    await expect(f.dev.cleanupDeleted(plan)).rejects.toThrow('outside uploads');
    expect(existsSync(file.path)).toBe(true); expect(readFileSync(join(outside, 'owner.json'), 'utf8')).toBe('project data');
  });
  test('scans long UTF-8 JSONL records without splitting escaped or Unicode line separators', async () => {
    const f = fixture(), file = f.upload(); f.dev.record('owner', f.input(file));
    const large = '中文\u2028\u2029\r\n'.repeat(20000);
    f.history(f.prodHome, 'long', [{ type: 'text', text: large }, ...f.input(file)]);
    expect((await f.dev.cleanupDeleted(await f.dev.prepareDelete('owner', {}))).retained).toBe(1);
  });
});
