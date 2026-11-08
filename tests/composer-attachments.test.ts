import { describe, expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { attachmentInput, clipboardFiles, createAttachmentController, MAX_ATTACHMENT_BYTES } from '../public/attachments.js';
function fixture(fetcher){const dom=new JSDOM('<form id="form"><textarea id="prompt"></textarea><input type="file" id="picker"><button type="button" id="button">+</button><div id="tray" hidden></div></form>');const d=dom.window.document;const errors=[];const controller=createAttachmentController({form:d.querySelector('#form'),prompt:d.querySelector('#prompt'),picker:d.querySelector('#picker'),tray:d.querySelector('#tray'),button:d.querySelector('#button'),onError:x=>errors.push(x),fetcher});return{controller,d,dom,errors}}
const response=(name='image.png',isImage=true)=>({ok:true,json:async()=>({id:'one',name,path:'/tmp/upload/'+name,size:123,isImage})});
describe('browser attachment workflow',()=>{
 test('pastes non-image files, including unknown MIME types, without duplicate uploads',async()=>{
  const requests=[];const f=fixture(async(url,options)=>{requests.push(options);return response('run.sh',false)});
  const file=new File(['#!/bin/sh\necho hi'],'run.sh',{type:''});
  const paste=new f.dom.window.Event('paste',{cancelable:true});
  Object.defineProperty(paste,'clipboardData',{value:{files:[file],items:[{kind:'file',type:'',getAsFile:()=>file},{kind:'string',type:'text/plain'}]}});
  f.d.querySelector('#prompt').dispatchEvent(paste);await new Promise(r=>setTimeout(r,0));
  expect(paste.defaultPrevented).toBe(true);expect(requests).toHaveLength(1);expect(requests[0].body).toBe(file);
  expect(requests[0].headers['x-upload-id']).toMatch(/^[a-f0-9-]{36}$/);
  expect(clipboardFiles({items:[{kind:'file',type:'application/pdf',getAsFile:()=>file}]})).toEqual([file]);
  f.dom.window.close();
 });
 test('deleting a completed draft calls the cleanup endpoint and waits for confirmation',async()=>{
  const deletes=[];let complete;
  const f=fixture((url,options)=>options.method==='DELETE'?(deletes.push(JSON.parse(options.body)),new Promise(r=>{complete=r})):Promise.resolve(response('note.txt',false)));
  await f.controller.addFiles([new File(['text'],'note.txt')]);f.d.querySelector('.composer-attachment-remove').click();
  expect(f.controller.isUploading()).toBe(true);expect(()=>f.controller.take()).toThrow();
  expect(f.d.querySelector('.composer-attachment-remove').disabled).toBe(true);expect(deletes[0].id).toBe('one');
  expect(deletes[0].uploadId).toMatch(/^[a-f0-9-]{36}$/);
  complete({ok:true,json:async()=>({deleted:1,retained:0,warning:false})});await new Promise(r=>setTimeout(r,0));
  expect(f.controller.hasFiles()).toBe(false);f.dom.window.close();
 });
 test('pending removal aborts the upload and cleans up a late successful response',async()=>{
  let finish;const requests=[];
  const f=fixture((url,options)=>{requests.push(options);return options.method==='DELETE'?Promise.resolve({ok:true,json:async()=>({deleted:1,retained:0,warning:false})}):new Promise(r=>{finish=r})});
  const uploading=f.controller.addFiles([new File(['bytes'],'late.txt')]);f.d.querySelector('.composer-attachment-remove').click();
  expect(requests[0].signal.aborted).toBe(true);finish(response('late.txt',false));await uploading;await new Promise(r=>setTimeout(r,0));
  const deleted=requests.filter(x=>x.method==='DELETE').map(x=>JSON.parse(x.body));
  expect(deleted.some(x=>x.id==='one')).toBe(true);expect(f.controller.hasFiles()).toBe(false);f.dom.window.close();
 });
 test('cleanup failures keep a retryable card and block sending a possibly removed attachment',async()=>{
  let failed=true;const f=fixture(async(url,options)=>options.method==='DELETE'?{ok:!failed,json:async()=>({warning:failed})}:response('note.txt',false));
  await f.controller.addFiles([new File(['x'],'note.txt')]);f.d.querySelector('.composer-attachment-remove').click();await new Promise(r=>setTimeout(r,0));
  expect(f.controller.hasFiles()).toBe(true);expect(f.errors).toHaveLength(1);expect(()=>f.controller.take()).toThrow();
  expect(f.d.querySelector('.composer-attachment-copy small').textContent).toBe('Removal failed');
  failed=false;f.d.querySelector('.composer-attachment-remove').click();await new Promise(r=>setTimeout(r,0));
  expect(f.controller.hasFiles()).toBe(false);f.dom.window.close();
 });
 test('sends images as real Codex image input, including image-only messages',()=>{const file={path:'/tmp/image.png',name:'image.png',isImage:true};expect(attachmentInput('',[file])).toEqual([{type:'localImage',path:'/tmp/image.png'}]);expect(attachmentInput('check',[file])).toEqual([{type:'text',text:'check'},{type:'localImage',path:'/tmp/image.png'}])});
 test('keeps ordinary text unchanged and makes non-images readable by Codex',()=>{expect(attachmentInput('hello',[])).toEqual([{type:'text',text:'hello'}]);expect(attachmentInput('',[{path:'/tmp/note.pdf',name:'note.pdf',isImage:false}])[0].text).toContain('/tmp/note.pdf')});
 test('uploads raw files, shows previews and can remove them before sending',async()=>{const requests=[];const f=fixture(async(url,options)=>{requests.push({url,options});return response()});await f.controller.addFiles([new File(['png'],'image.png',{type:'image/png'})]);expect(requests[0].url).toBe('/api/attachments');expect(requests[0].options.body).toBeInstanceOf(File);expect(f.controller.isUploading()).toBe(false);expect(f.d.querySelector('img').getAttribute('src')).toContain('/api/images/local?');f.d.querySelector('.composer-attachment-remove').click();await new Promise(r=>setTimeout(r,0));expect(f.controller.hasFiles()).toBe(false);f.dom.window.close()});
 test('blocks taking attachments while uploads are in progress',async()=>{let finish;const f=fixture(()=>new Promise(r=>{finish=r}));const upload=f.controller.addFiles([new File(['x'],'image.png')]);expect(f.controller.isUploading()).toBe(true);expect(()=>f.controller.take()).toThrow();finish(response());await upload;expect(f.controller.take()).toHaveLength(1);expect(f.controller.hasFiles()).toBe(false);f.dom.window.close()});
 test('restores uploaded attachments after send errors without another upload',async()=>{let requests=0;const f=fixture(async()=>{requests++;return response()});await f.controller.addFiles([new File(['x'],'image.png')]);const files=f.controller.take();f.controller.restore(files);f.controller.restore(files);expect(f.controller.snapshot()).toHaveLength(1);expect(requests).toBe(1);f.dom.window.close()});
 test('handles errors and over-limit files without leaving broken attachments',async()=>{const f=fixture(async()=>({ok:false,json:async()=>({error:'Upload failed'})}));await f.controller.addFiles([new File(['x'],'file.txt')]);expect(f.controller.hasFiles()).toBe(false);await f.controller.addFiles([{name:'big.png',size:MAX_ATTACHMENT_BYTES+1}]);expect(f.errors).toHaveLength(2);f.dom.window.close()});
 test('renders filenames as text instead of HTML',async()=>{const f=fixture(async()=>response('<img src=x onerror=alert(1)>.txt',false));await f.controller.addFiles([new File(['x'],'safe.txt')]);expect(f.d.querySelector('.composer-attachment-name').textContent).toBe('<img src=x onerror=alert(1)>.txt');expect(f.d.querySelector('img')).toBeNull();f.dom.window.close()});
 test('pasting images attaches them while ordinary paste is left alone',async()=>{let requests=0;const f=fixture(async()=>{requests++;return response()});const file=new File(['x'],'image.png',{type:'image/png'});const paste=new f.dom.window.Event('paste',{cancelable:true});Object.defineProperty(paste,'clipboardData',{value:{items:[{kind:'file',type:'image/png',getAsFile:()=>file}]}});f.d.querySelector('#prompt').dispatchEvent(paste);await new Promise(r=>setTimeout(r,0));expect(paste.defaultPrevented).toBe(true);expect(requests).toBe(1);const plain=new f.dom.window.Event('paste',{cancelable:true});Object.defineProperty(plain,'clipboardData',{value:{items:[{kind:'string',type:'text/plain'}]}});f.d.querySelector('#prompt').dispatchEvent(plain);expect(plain.defaultPrevented).toBe(false);f.dom.window.close()});
 test('clearing the composer aborts pending uploads and prevents late restoration',async()=>{let finish;const f=fixture((url,options)=>options.method==='DELETE'?Promise.resolve({ok:true,json:async()=>({deleted:0,retained:0,warning:false})}):new Promise(r=>{finish=r}));const upload=f.controller.addFiles([new File(['x'],'image.png')]);f.controller.clear();finish(response());await upload;expect(f.controller.hasFiles()).toBe(false);f.dom.window.close()});
});
