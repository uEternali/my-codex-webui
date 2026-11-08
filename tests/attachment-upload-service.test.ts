import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AttachmentLifecycle } from '../attachment-lifecycle-service.js';
import { AttachmentUploadStore } from '../attachment-upload-service.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'webui-upload-removal-')); roots.push(root);
  const codexHome = join(root, 'codex'); mkdirSync(codexHome);
  const lifecycle = new AttachmentLifecycle({ directory: join(root, 'uploads'), codexHome });
  const uploads = new AttachmentUploadStore(lifecycle);
  const upload = () => { const request = uploads.begin(); return { request, file: uploads.store(request, Buffer.from('keep this content'), { filename: 'note.txt' }) }; };
  return { root, lifecycle, uploads, upload };
}
describe('upload cancellation and draft removal', () => {
  test('remembers cancellation arriving before the upload request', async () => {
    const f = fixture(), id = randomUUID();
    await f.uploads.discard({ uploadId: id });
    expect(() => f.uploads.begin(id)).toThrow(); expect(f.lifecycle.files()).toHaveLength(0);
  });
  test('does not store the body of an upload removed while still in flight', async () => {
    const f = fixture(), request = f.uploads.begin(); await f.uploads.discard({ uploadId: request.id });
    expect(() => f.uploads.store(request, Buffer.from('late upload'), { filename: 'late.txt' })).toThrow();
    expect(f.lifecycle.files()).toHaveLength(0);
  });
  test('removes a completed file by its request id even when the browser missed the response', async () => {
    const f = fixture(), { request, file } = f.upload();
    expect(file.id).not.toBe(request.id);
    expect((await f.uploads.discard({ uploadId: request.id })).deleted).toBe(1);
    expect(existsSync(file.path)).toBe(false);
  });
  test('removes completed drafts by file id after a backend restart and keeps referenced files', async () => {
    const f = fixture(), first = f.upload(), second = f.upload(), restarted = new AttachmentUploadStore(f.lifecycle);
    f.lifecycle.record('saved-chat', [{ type: 'localImage', path: second.file.path }]);
    expect((await restarted.discard({ id: first.file.id })).deleted).toBe(1);
    expect((await restarted.discard({ id: second.file.id })).retained).toBe(1);
    expect(existsSync(second.file.path)).toBe(true);
  });
  test('rejects traversal and mismatched identifiers; never follows a symlink to a project file', async () => {
    const f = fixture(), { request, file } = f.upload(), outside = join(f.root, 'project.txt'); writeFileSync(outside, 'project data');
    await expect(f.uploads.discard({ id: '../../project.txt' })).rejects.toThrow();
    await expect(f.uploads.discard({ id: randomUUID(), uploadId: request.id })).rejects.toThrow();
    rmSync(file.path); symlinkSync(outside, file.path);
    expect((await f.uploads.discard({ id: file.id })).deleted).toBe(0);
    expect(readFileSync(outside, 'utf8')).toBe('project data');
  });
});
