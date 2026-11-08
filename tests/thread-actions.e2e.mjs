import { createServer } from 'node:net';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';
import { artifact, launchOptions, root } from './browser-runtime.mjs';
const assert=(value,message)=>{if(!value)throw Error(message)};
const temporary=await mkdtemp(join(tmpdir(),'webui-thread-actions-'));
const bin=join(temporary,'bin'),home=join(temporary,'codex'),log=join(temporary,'rpc.jsonl'),control=join(temporary,'control.json');
await mkdir(bin);await mkdir(home);await writeFile(log,'');
let settings={finish:0,compact:'hold',fork:'ok',omitForks:true};
const configure=async changes=>{Object.assign(settings,changes);await writeFile(control+'.next',JSON.stringify(settings));await rename(control+'.next',control)};await configure({});
await copyFile(join(root,'tests/fixtures/thread-actions-codex.mjs'),join(bin,'codex'));await chmod(join(bin,'codex'),0o700);
const port=await new Promise(resolve=>{const server=createServer();server.listen(0,'127.0.0.1',()=>{const value=server.address().port;server.close(()=>resolve(value))})});
const base=`http://127.0.0.1:${port}`;
const server=Bun.spawn([process.execPath,'run','server.ts'],{cwd:root,env:{...process.env,PATH:`${bin}:${dirname(process.execPath)}:${process.env.PATH}`,HOST:'127.0.0.1',PORT:String(port),CODEX_HOME:home,CODEX_WEBUI_CWD:homedir(),CODEX_WEBUI_AUTH_STORE:join(temporary,'auth.json'),CODEX_WEBUI_PASSWORD:'',CODEX_WEBUI_ACCESS_TOKEN:'',ACTION_FIXTURE_LOG:log,ACTION_FIXTURE_CONTROL:control},stdout:'ignore',stderr:'inherit'});
const protocol=async()=>(await readFile(log,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
let browser;
const errors=[],results=[];
try{
 const deadline=Date.now()+15000;while(true){try{if((await fetch(base+'/api/health').then(r=>r.json())).codex)break}catch{}if(Date.now()>deadline)throw Error('Fixture startup timeout');await Bun.sleep(40)}
 browser=await chromium.launch(launchOptions());
 for(const transport of ['ws','sse']){
  await configure({compact:'hold',fork:'ok'});
  const context=await browser.newContext({viewport:{width:1120,height:850},permissions:['clipboard-read','clipboard-write']});
  await context.addInitScript(()=>{if(window===window.top)localStorage.setItem('codex-webui-locale','en')});
  const page=await context.newPage();page.setDefaultTimeout(9000);page.on('pageerror',error=>errors.push(error.message));
  if(transport==='sse')await page.routeWebSocket('**/ws',socket=>socket.close());
  await page.goto(base);await page.waitForFunction(()=>globalThis.__codexWebuiDebug?.state.connected);
  // A slash command is handled locally even when no thread is selected.
  const startsBeforeCommand=(await protocol()).filter(x=>x.method==='turn/start').length;
  await page.locator('#prompt').fill('/compact');await page.locator('#prompt').press('Enter');
  await page.getByText('Open a task before compacting',{exact:true}).waitFor();
  assert((await protocol()).filter(x=>x.method==='turn/start').length===startsBeforeCommand,'Never send /compact as a model prompt');
  await page.evaluate(id=>globalThis.__codexWebuiDebug.openThread(id),`parent-${transport}`);
  const first=page.locator(`[data-turn-id="parent-${transport}-first"]`);
  const raw='**Original Markdown**\n\n```js\nconsole.log("hello");\n```\n\n[Source](https://example.com)\n';
  await first.getByRole('button',{name:'Copy reply',exact:true}).click();
  assert(await page.evaluate(()=>navigator.clipboard.readText())===raw,'Copy the original Markdown including code fences, links and line breaks');
  const textareasBefore=await page.locator('textarea').count();
  await page.evaluate(()=>{window.__realClipboard=navigator.clipboard;Object.defineProperty(navigator,'clipboard',{configurable:true,value:undefined});const original=document.execCommand.bind(document);document.execCommand=(name,...args)=>{if(name==='copy')window.__fallbackText=document.activeElement.value;return original(name,...args)}});
  await first.getByRole('button',{name:'Copy reply',exact:true}).click();
  assert(await page.evaluate(()=>window.__fallbackText)===raw,'Copy also works on insecure HTTP/LAN pages');
  assert(await page.locator('textarea').count()===textareasBefore,'Remove the temporary clipboard field');
  await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:window.__realClipboard}));
  await page.locator('#prompt').fill('/compact');await page.locator('#prompt').press('Enter');
  await page.locator('[data-compaction-pending]').waitFor();
  assert(await page.locator('#sendButton').isDisabled(),'Prevent a second request before native turn/start');
  await page.waitForFunction(()=>!!document.querySelector('.activity-item.active .activity-label')?.textContent.includes('Compacting'));
  assert(await page.locator('.activity-item.active').textContent()==='Compacting context…','RPC admission is not compaction completion');
  await page.locator('#prompt').fill('/compact');await page.locator('#prompt').press('Enter');
  assert((await protocol()).filter(x=>x.method==='thread/compact/start'&&x.params.threadId===`parent-${transport}`).length===1,'Do not compact twice while running');
  await page.reload();await page.locator('.activity-item.active .activity-label').getByText('Compacting context…',{exact:true}).waitFor();
  await configure({finish:settings.finish+1});
  await page.locator('.activity-item .activity-label').filter({hasText:'Context compacted'}).waitFor();
  await page.waitForFunction(()=>!document.querySelector('#sendButton').dataset.turnId);
  assert(await page.locator('.activity-item .loading-shimmer').count()===0,'Compaction completion clears its progress animation');
  assert(await page.locator('#contextUsage').getAttribute('aria-label')==='Context usage: 8%','Display native post-compaction usage');
  await page.reload();await page.locator('.activity-item .activity-label').filter({hasText:'Context compacted'}).waitFor();
  // Both immediate RPC errors and asynchronous model errors appear in the transcript.
  await configure({compact:'reject'});
  await page.locator('#prompt').fill('/compact');await page.locator('#sendButton').click();
  await page.locator('#conversation').getByText('HTTP 503: could not start compaction',{exact:true}).waitFor();
  assert(await page.locator('#prompt').inputValue()==='/compact','A rejected command remains available for retry');
  await configure({compact:'fail'});
  await page.locator('#prompt').press('Enter');
  await page.locator('#conversation').getByText('HTTP 503: compaction upstream unavailable',{exact:true}).waitFor();
  await page.locator('.activity-item .activity-label').filter({hasText:'Context compaction failed'}).waitFor();
  await page.waitForFunction(()=>!document.querySelector('#sendButton').dataset.turnId);
  await page.locator('#prompt').fill('Ordinary task');await page.locator('#prompt').press('Enter');
  await page.waitForFunction(()=>document.querySelector('#sendButton').dataset.turnId?.startsWith('running-'));
  const countBefore=(await protocol()).filter(x=>x.method==='thread/compact/start').length;
  await page.locator('#prompt').fill('/compact');await page.locator('#prompt').press('Enter');
  await page.getByText('Wait for the current task to finish before compacting',{exact:true}).waitFor();
  assert((await protocol()).filter(x=>x.method==='thread/compact/start').length===countBefore,'Compacting never interrupts an active task');
  await page.locator('#prompt').fill('');await page.locator('#sendButton').click();
  await page.waitForFunction(()=>!document.querySelector('#sendButton').dataset.turnId);
  await configure({fork:'reject'});await first.getByRole('button',{name:'Branch from here',exact:true}).click();
  await page.locator('#conversation').getByText('HTTP 503: could not create branch',{exact:true}).waitFor();
  assert(await first.getAttribute('data-turn-status')==='completed','A branch failure must not alter the source turn');
  await configure({fork:'ok'});await page.locator('#prompt').fill('Unsent draft');
  await first.getByRole('button',{name:'Branch from here',exact:true}).click();
  await first.getByRole('button',{name:'Branch from here',exact:true}).dispatchEvent('click');
  await page.waitForFunction(()=>globalThis.__codexWebuiDebug.state.active?.id.startsWith('branch-'));
  await page.waitForFunction(()=>document.querySelectorAll('.user-message-text').length===1);
  assert(await page.locator('.user-message-text').textContent()==='First question','Fork from exactly the selected turn, omitting newer messages');
  assert(await page.locator('#prompt').inputValue()==='Unsent draft','Creating a branch preserves the draft');
  const forkCalls=(await protocol()).filter(x=>x.method==='thread/fork'&&x.params.threadId===`parent-${transport}`);
  assert(forkCalls.length===2&&forkCalls.every(x=>x.params.lastTurnId===`parent-${transport}-first`&&x.params.deferGoalContinuation===true),'Use one exact boundary per click and defer automatic goal continuation');
  const branchId=await page.evaluate(()=>globalThis.__codexWebuiDebug.state.active.id);
  assert(await page.locator('#threadTitle').textContent()===`分支 · Actions fixture ${transport}`,'A branch receives the source chat name with the requested prefix');
  assert(await page.locator(`.thread-item[data-id="${branchId}"]`).count()===1,'The new session appears once in the sidebar');
  await page.reload();await page.locator('[data-copy-reply]').waitFor();
  assert(await page.locator('.user-message-text').count()===1,'The branch boundary persists after refresh');
  assert(await page.locator(`.thread-item[data-id="${branchId}"]`).count()===1,'An unlisted native fork remains in the sidebar after refresh');
  // Check real flex geometry, not only DOM order, at desktop and narrow widths.
  await page.evaluate(()=>globalThis.__codexWebuiDebug.notify('thread/tokenUsage/updated',{threadId:globalThis.__codexWebuiDebug.state.active.id,tokenUsage:{modelContextWindow:100000,last:{totalTokens:8000}}}));
  for(const width of [1120,390,320]){
   await page.setViewportSize({width,height:850});
   const geometry=await page.evaluate(()=>{
    const nodes=[document.querySelector('#modelPicker'),document.querySelector('#contextUsage'),document.querySelector('[data-composer-control="dictation"]'),document.querySelector('#sendButton')];
    const rects=nodes.map(node=>node.getBoundingClientRect());return{right:nodes.every(node=>node.parentElement.classList.contains('composer-right')),ordered:rects.every((r,i)=>!i||rects[i-1].right<=r.left+.5),onscreen:rects.every(r=>r.width>0&&r.left>=0&&r.right<=innerWidth),overflow:document.documentElement.scrollWidth>innerWidth};
   });
   assert(geometry.right&&geometry.ordered&&geometry.onscreen&&!geometry.overflow,`Composer layout ${width}px: ${JSON.stringify(geometry)}`);
   await page.locator('#modelButton').click();
   assert(await page.locator('#modelMenu').isVisible(),'The moved model picker still opens');
   await page.locator('#prompt').press('Escape');
  }
  if(transport==='ws'){
   // A lost response must not resend an already accepted compaction.
   await configure({compact:'delayed-reply'});
   const before=(await protocol()).filter(x=>x.method==='thread/compact/start').length;
   await page.locator('#prompt').fill('/compact');await page.locator('#prompt').press('Enter');
   const deadline=Date.now()+5000;while((await protocol()).filter(x=>x.method==='thread/compact/start').length===before){if(Date.now()>deadline)throw Error('Missing compact request');await Bun.sleep(20)}
   await page.evaluate(()=>globalThis.__codexWebuiDebug.state.ws.close());
   await page.waitForFunction(()=>globalThis.__codexWebuiDebug.state.transport==='sse'&&globalThis.__codexWebuiDebug.state.connected);
   await page.locator('.activity-item.active .activity-label').getByText('Compacting context…',{exact:true}).waitFor();
   await configure({finish:settings.finish+1});
   await page.locator('.activity-item .activity-label').filter({hasText:'Context compacted'}).waitFor();
   await page.waitForFunction(()=>!document.querySelector('#sendButton').dataset.turnId);
   assert((await protocol()).filter(x=>x.method==='thread/compact/start').length===before+1,'Do not repeat accepted compaction after a connection change');
   assert(await page.locator('#sendButton').isEnabled(),'Restore composer after compaction with a lost response');
  }
  if(transport==='ws'){
   // If admission was lost, reconfirm idle state instead of leaving Send disabled.
   const lostContext=await browser.newContext({viewport:{width:1120,height:850}});
   await lostContext.addInitScript(()=>{if(window===window.top)localStorage.setItem('codex-webui-locale','en')});
   const lost=await lostContext.newPage();lost.setDefaultTimeout(20000);
   lost.on('pageerror',error=>errors.push(error.message));
   await lost.goto(base);await lost.waitForFunction(()=>globalThis.__codexWebuiDebug?.state.connected);
   await lost.evaluate(id=>globalThis.__codexWebuiDebug.openThread(id),`parent-${transport}`);
   await configure({compact:'lost'});
   const before=(await protocol()).filter(x=>x.method==='thread/compact/start').length;
   await lost.locator('#prompt').fill('/compact');await lost.locator('#prompt').press('Enter');
   const deadline=Date.now()+5000;while((await protocol()).filter(x=>x.method==='thread/compact/start').length===before){if(Date.now()>deadline)throw Error('Missing lost-admission request');await Bun.sleep(20)}
   await lost.evaluate(()=>globalThis.__codexWebuiDebug.state.ws.close());
   await lost.locator('#conversation').getByText('Could not confirm context compaction. Try /compact again.',{exact:true}).waitFor();
   assert(await lost.locator('#sendButton').isEnabled(),'Clear uncertain compaction when the reconnected task stays idle');
   assert((await lost.locator('#prompt').inputValue()).trim()==='/compact','Keep the retry command after a lost admission');
   assert((await protocol()).filter(x=>x.method==='thread/compact/start').length===before+1,'Never automatically resubmit uncertain compaction');
   await lostContext.close();
  }
  await page.screenshot({path:artifact(`thread-actions-${transport}.png`)});
  results.push({transport,rawCopy:true,httpCopy:true,compactReload:true,errors:true,exactForkBoundary:true,responsiveOrder:true});await context.close();
 }
 assert(!errors.length,`Browser errors: ${errors.join('; ')}`);console.log(JSON.stringify({results,browserErrors:errors},null,2));
}catch(error){console.error('Test failure:',error.message);console.error('Recent RPC:',JSON.stringify((await protocol()).slice(-14)));const page=browser?.contexts().at(-1)?.pages().at(-1);if(page){console.error('Failure UI:',await page.locator('#conversation').innerText({timeout:1000}).catch(()=>'(conversation unavailable)'));console.error('Composer:',await page.locator('#prompt').inputValue({timeout:1000}).catch(()=>'(prompt unavailable)'),await page.locator('#sendButton').getAttribute('data-submit-mode',{timeout:1000}).catch(()=>null));await page.screenshot({path:artifact('thread-actions-failure.png')})}throw error}finally{await browser?.close();server.kill();await server.exited;await rm(temporary,{recursive:true,force:true})}
