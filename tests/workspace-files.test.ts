import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listWorkspaceDirectory, previewWorkspaceFile } from '../workspace-files-service.js';

const temporary: string[] = [];
afterEach(async () => { for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'webui-workspace-files-')); temporary.push(root);
  await mkdir(join(root, 'src')); await mkdir(join(root, '.git'));
  await writeFile(join(root, 'notes.txt'), '第一行\nsecond line\n');
  await writeFile(join(root, 'src', 'hello.js'), 'console.log("hello");');
  return { root, options: { allowedRoots: [root] } };
}

describe('read-only workspace browser', () => {
  test('revision probes omit unchanged listings and text while detecting edits and replacements', async () => {
    const { root, options } = await fixture();
    const directory = await listWorkspaceDirectory(root, '', options);
    const file = await previewWorkspaceFile(root, 'notes.txt', options);
    expect(await listWorkspaceDirectory(root, '', { ...options, revision: directory.revision })).toEqual({ unchanged: true, revision: directory.revision });
    expect(await previewWorkspaceFile(root, 'notes.txt', { ...options, revision: file.revision })).toEqual({ unchanged: true, revision: file.revision });
    await writeFile(join(root, 'new.py'), 'print(1)');
    expect((await listWorkspaceDirectory(root, '', { ...options, revision: directory.revision })).entries?.some(entry => entry.name === 'new.py')).toBe(true);
    await writeFile(join(root, 'replacement.txt'), 'new text\n'); await rename(join(root, 'replacement.txt'), join(root, 'notes.txt'));
    const replaced = await previewWorkspaceFile(root, 'notes.txt', { ...options, revision: file.revision });
    expect(replaced.text).toBe('new text\n'); expect(replaced.revision).not.toBe(file.revision);
    await rm(join(root, 'notes.txt')); await symlink(join(root, 'new.py'), join(root, 'notes.txt'));
    await expect(previewWorkspaceFile(root, 'notes.txt', { ...options, revision: replaced.revision })).rejects.toThrow('Symbolic links');
  });
  test('lists one directory at a time, directories first, including hidden entries', async () => {
    const { root, options } = await fixture();
    const listing = await listWorkspaceDirectory(root, '', options);
    expect(listing.entries.map(entry => entry.path)).toEqual(['.git', 'src', 'notes.txt']);
    expect(listing.truncated).toBe(false);
    expect((await listWorkspaceDirectory(root, 'src', options)).entries).toEqual([{ name: 'hello.js', path: 'src/hello.js', kind: 'file' }]);
    const limited = await listWorkspaceDirectory(root, '', { ...options, limit: 2 });
    expect(limited.entries).toHaveLength(2); expect(limited.truncated).toBe(true);
  });

  test('previews UTF-8, BOM encoded text and empty files with line counts', async () => {
    const { root, options } = await fixture();
    expect(await previewWorkspaceFile(root, 'notes.txt', options)).toMatchObject({ kind: 'text', text: '第一行\nsecond line\n', encoding: 'UTF-8', lineCount: 3 });
    await writeFile(join(root, 'utf16.txt'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('中文\r\ntext', 'utf16le')]));
    expect(await previewWorkspaceFile(root, 'utf16.txt', options)).toMatchObject({ kind: 'text', text: '中文\r\ntext', encoding: 'UTF-16LE', lineCount: 2 });
    await writeFile(join(root, 'empty.txt'), '');
    expect(await previewWorkspaceFile(root, 'empty.txt', options)).toMatchObject({ kind: 'text', text: '', size: 0, lineCount: 1 });
  });

  test('keeps literal percent sequences, spaces and Unicode filenames intact', async () => {
    const { root, options } = await fixture();
    const name = '测试 100%20%2e.txt'; await writeFile(join(root, name), 'literal');
    const preview = await previewWorkspaceFile(root, name, options);
    expect(preview).toMatchObject({ path: name, name, text: 'literal' });
    expect(fileURLToPath(preview.fileUrl)).toBe(await realpath(join(root, name)));
  });

  test('returns image and binary metadata without interpreting active content', async () => {
    const { root, options } = await fixture();
    await writeFile(join(root, 'photo.png'), Buffer.from([137, 80, 78, 71]));
    await writeFile(join(root, 'raw.bin'), Buffer.from([0, 1, 2, 3]));
    await writeFile(join(root, 'drawing.svg'), '<svg onload="alert(1)"></svg>');
    expect(await previewWorkspaceFile(root, 'photo.png', options)).toMatchObject({ kind: 'image', size: 4 });
    expect(await previewWorkspaceFile(root, 'raw.bin', options)).toMatchObject({ kind: 'unavailable', reason: 'binary' });
    expect(await previewWorkspaceFile(root, 'drawing.svg', options)).toMatchObject({ kind: 'text', text: '<svg onload="alert(1)"></svg>' });
  });

  test('bounds text bytes and line counts before returning content to the browser', async () => {
    const { root, options } = await fixture();
    expect(await previewWorkspaceFile(root, 'notes.txt', { ...options, maxBytes: 2 })).toMatchObject({ kind: 'unavailable', reason: 'too-large' });
    await writeFile(join(root, 'many-lines.txt'), '\n'.repeat(10001));
    expect(await previewWorkspaceFile(root, 'many-lines.txt', options)).toMatchObject({ kind: 'unavailable', reason: 'too-many-lines' });
  });

  test('rejects traversal, absolute paths, invalid roots, folders and symbolic-link escapes', async () => {
    const { root, options } = await fixture();
    const outside = await mkdtemp(join(tmpdir(), 'webui-outside-')); temporary.push(outside);
    await writeFile(join(outside, 'secret.txt'), 'outside');
    await symlink(outside, join(root, 'external'));
    await symlink(join(root, 'notes.txt'), join(root, 'linked.txt'));
    for (const path of ['../secret.txt', '/etc/hosts', 'external/secret.txt', 'linked.txt', 'bad\0name', 'src']) {
      await expect(previewWorkspaceFile(root, path, options)).rejects.toThrow();
    }
    await expect(listWorkspaceDirectory(root, 'external', options)).rejects.toThrow();
    await expect(listWorkspaceDirectory(outside, '', options)).rejects.toThrow('outside allowed roots');
    await expect(listWorkspaceDirectory('', '', options)).rejects.toThrow('Choose a project');
    expect((await listWorkspaceDirectory(root, '', options)).entries.find(entry => entry.name === 'external')?.kind).toBe('link');
  });
});
