import { describe, expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { attachmentInput } from '../public/attachments.js';
import { attachmentFileType, renderUserAttachments, userMessageContent } from '../public/user-attachments.js';

const directory = '/home/test/.cache/codex-webui/uploads';
const pdf = { name: '报告.pdf', path: `${directory}/11111111-1111-4111-8111-111111111111-报告.pdf`, isImage: false };
const image = { name: '截图.png', path: `${directory}/22222222-2222-4222-8222-222222222222-截图.png`, isImage: true };

describe('user attachment presentation', () => {
  test('separates wire file instructions from visible text without changing model input', () => {
    const input = attachmentInput('看看这两个文件是什么', [pdf, image]);
    const original = JSON.stringify(input);
    expect(userMessageContent({ content: input })).toEqual({ text: '看看这两个文件是什么', attachments: [pdf, image] });
    expect(JSON.stringify(input)).toBe(original);
    expect(input[1].text).toContain('Server path:');
  });
  test('recognizes combined historical text and legacy upload locations after refresh', () => {
    const legacy = { ...pdf, path: pdf.path.replace(directory, '/home/test/.codex/codex-webui-uploads') };
    const texts = attachmentInput('Keep my\nmessage', [legacy, pdf]).map(part => part.text).join('\n');
    expect(userMessageContent({ content: [{ type: 'text', text: texts }] })).toEqual({ text: 'Keep my\nmessage', attachments: [legacy, pdf] });
  });
  test('leaves ordinary text, examples and non-upload file paths visible', () => {
    const text = 'Attached file: note.txt\nServer path: /workspace/note.txt\nRead this file as needed for this request.';
    expect(userMessageContent({ content: [{ type: 'text', text }] })).toEqual({ text, attachments: [] });
    const example = '```text\n' + attachmentInput('', [pdf])[0].text + '\n```';
    expect(userMessageContent({ content: [{ type: 'text', text: example }] }).text).toBe(example);
  });
  test('supports image-only messages, native image shapes and duplicate image paths', () => {
    expect(userMessageContent({ content: [{ type: 'image', url: image.path }], imagePaths: [image.path] })).toEqual({ text: '', attachments: [image] });
    expect(userMessageContent({ content: 'plain text' })).toEqual({ text: 'plain text', attachments: [] });
  });
  test('renders escaped filenames, safe downloads and image-viewer thumbnails', () => {
    const hostile = { ...pdf, name: '<img src=x onerror=alert(1)>.pdf' };
    const dom = new JSDOM(renderUserAttachments([hostile, image], { cwd: '/workspace' }));
    const doc = dom.window.document;
    expect(doc.querySelectorAll('.user-attachment')).toHaveLength(2);
    expect(doc.querySelectorAll('img')).toHaveLength(1);
    expect(doc.querySelector('.user-attachment-file .user-attachment-name').textContent).toBe(hostile.name);
    expect(doc.querySelector('.user-attachment-file').getAttribute('href')).toContain('/api/files/download?path=');
    expect(doc.querySelector('.user-attachment-image').getAttribute('data-image-path')).toBe(image.path);
    expect(doc.querySelector('.user-attachment-image .user-attachment-name').textContent).toBe(image.name);
    expect(doc.querySelector('[onerror]')).toBeNull();
    expect(renderUserAttachments([{ name: 'bad', path: 'javascript:alert(1)', isImage: false }])).toBe('');
    dom.window.close();
  });
  test('gives scripts, archives and documents recognizable type icons and labels', () => {
    expect(attachmentFileType('run.sh')).toEqual({ icon: 'terminal', tone: 'code', label: 'SH' });
    expect(attachmentFileType('data.xlsx').tone).toBe('sheet');
    expect(attachmentFileType('report.pdf').tone).toBe('pdf');
    expect(attachmentFileType('backup.tar.gz').icon).toBe('archive');
    expect(attachmentFileType('README').label).toBe('FILE');
  });
});
