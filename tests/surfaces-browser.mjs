import { chromium } from 'playwright';
import { artifact, launchOptions } from './browser-runtime.mjs';
const browser=await chromium.launch(launchOptions());
async function checkSubmitHover(page,mode,name){
 await page.mouse.move(0,0);
 const read=()=>{const button=document.querySelector('#sendButton'),svg=button.querySelector('svg'),s=getComputedStyle(button);return{mode:button.dataset.submitMode,background:s.backgroundColor,color:s.color,filter:s.filter,icon:svg.querySelector('rect')?getComputedStyle(svg.querySelector('rect')).fill:getComputedStyle(svg).stroke}};
 const normal=await page.evaluate(read);
 await page.hover('#sendButton');
 const hovered=await page.evaluate(read);
 if(normal.mode!==mode||normal.background===hovered.background||normal.color!==hovered.color||normal.icon!==hovered.icon||hovered.filter!=='none')throw new Error(`${name} ${mode} hover must change only the button background: ${JSON.stringify({normal,hovered})}`);
 await page.screenshot({path:artifact(`${name}-${mode}-hover.png`),fullPage:false});
 return{mode,normal,hovered};
}
async function run(width,height,name,colorScheme='light'){
 const page=await browser.newPage({viewport:{width,height},isMobile:width<720,hasTouch:width<720,colorScheme});
 const errors=[];page.on('pageerror',e=>{errors.push(e.message);console.log(name,'pageerror',e.message)});page.on('console',m=>{console.log(name,'console',m.type(),m.text());if(m.type()==='error'&&!m.text().includes('404'))errors.push(m.text())});
 page.on('response',response=>{if(response.status()>=400)console.log(name,'HTTP',response.status(),response.url())});
 await page.goto(process.env.CODEX_WEBUI_TEST_URL||'http://127.0.0.1:8899',{waitUntil:'networkidle'});
 await page.waitForTimeout(1000);
 console.log(name,'debug-state',await page.evaluate(()=>({debug:!!globalThis.__codexWebuiDebug,scripts:[...document.scripts].map(s=>s.src)})));
 await page.waitForFunction(()=>globalThis.__codexWebuiDebug);
 await page.evaluate(()=>globalThis.__codexWebuiDebug.startNewTask());
 const sendHover=await checkSubmitHover(page,'send',name);
 await page.evaluate(async()=>{
   const api=globalThis.__codexWebuiDebug;
   api.startNewTask();
   api.state.active={id:'thread-demo',cwd:api.state.config.defaultCwd,turns:[],canAcceptDirectInput:true};
   api.notify('turn/started',{threadId:'thread-demo',turn:{id:'turn-demo',status:'inProgress',items:[]}});
   api.notify('item/started',{turnId:'turn-demo',item:{id:'cmd-demo',type:'commandExecution',status:'inProgress',command:'bun test tests/codex-surfaces.test.ts'}});
   api.notify('turn/diff/updated',{turnId:'turn-demo',threadId:'thread-demo',diff:'diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,2 +1,3 @@\n const app = true;\n-old();\n+next();\n+export { next };\n'});
   await api.request({id:'approval-demo',method:'item/commandExecution/requestApproval',params:{threadId:'thread-demo',turnId:'turn-demo',itemId:'cmd-demo',command:'bun test tests/codex-surfaces.test.ts',cwd:globalThis.__codexWebuiDebug.state.config.defaultCwd||'.',reason:'Run the focused test suite to verify the UI changes.',proposedExecpolicyAmendment:['bun','test'],startedAtMs:Date.now()}});
 });
 await page.waitForSelector('[data-codex-approval-surface]');
 await page.waitForSelector('.activity-command-icon svg');
 await page.waitForSelector('.review-file',{state:'attached'});
 const stopHover=await checkSubmitHover(page,'stop',name);
 await page.mouse.move(0,0);
 const buttonStyle=await page.evaluate(()=>{
  const style=selector=>{const s=getComputedStyle(document.querySelector(selector));return{background:s.backgroundColor,color:s.color,border:s.borderTopColor,width:s.borderTopWidth}};
  return{deny:style('.approval-deny'),allow:style('.approval-primary'),toggle:style('.approval-menu-toggle')};
 });
 if(JSON.stringify(buttonStyle.deny)!==JSON.stringify(buttonStyle.allow)||JSON.stringify(buttonStyle.deny)!==JSON.stringify(buttonStyle.toggle))throw new Error(`${name} approval buttons must share the Deny style: ${JSON.stringify(buttonStyle)}`);
 await page.hover('.approval-deny');
 const denyHover=await page.locator('.approval-deny').evaluate(node=>getComputedStyle(node).backgroundColor);
 await page.hover('.approval-primary');
 const allowHover=await page.locator('.approval-primary').evaluate(node=>getComputedStyle(node).backgroundColor);
 if(denyHover!==allowHover)throw new Error(`${name} approval button hover styles differ`);
 const arrowCenter=await page.locator('.approval-menu-toggle').evaluate(button=>{const b=button.getBoundingClientRect(),icon=button.querySelector('svg').getBoundingClientRect();return{x:Math.abs(icon.left+icon.width/2-b.left-b.width/2),y:Math.abs(icon.top+icon.height/2-b.top-b.height/2)}});
 if(arrowCenter.x>0.75||arrowCenter.y>0.75)throw new Error(`${name} approval arrow must be centered: ${JSON.stringify(arrowCenter)}`);
 await page.click('.approval-menu-toggle');
 const menuGeometry=await page.evaluate(()=>{
  const option=document.querySelector('.approval-scoped'),menu=option.closest('.approval-menu');
  const r=option.getBoundingClientRect(),m=menu.getBoundingClientRect(),toggle=document.querySelector('.approval-menu-toggle').getBoundingClientRect();
  const x=r.left+r.width/2,y=r.top+r.height/2,points=[[x,y],[x,r.top+2],[x,r.bottom-2],[r.left+2,y],[r.right-2,y]];
  return {above:m.bottom<=toggle.top,withinViewport:m.left>=0&&m.right<=innerWidth&&m.top>=0&&m.bottom<=innerHeight,clickable:points.every(([x,y])=>option.contains(document.elementFromPoint(x,y)))};
 });
 if(!menuGeometry.above||!menuGeometry.withinViewport||!menuGeometry.clickable)throw new Error(`${name} approval menu clipped or covered: ${JSON.stringify(menuGeometry)}`);
 await page.screenshot({path:artifact(`approval-menu-${name}.png`),fullPage:false});
 const menuColors=await page.evaluate(()=>{
  const style=selector=>{const s=getComputedStyle(document.querySelector(selector));return{background:s.backgroundColor,color:s.color,border:s.borderTopColor,width:s.borderTopWidth}};
  return{background:getComputedStyle(document.querySelector('.approval-menu')).backgroundColor,card:getComputedStyle(document.querySelector('.approval-card')).backgroundColor,option:style('.approval-scoped')};
 });
 await page.hover('.approval-scoped');
 const hoverColors=await page.evaluate(()=>({background:getComputedStyle(document.querySelector('.approval-scoped')).backgroundColor}));
 if(menuColors.background!==menuColors.card||menuColors.option.width!=='0px'||menuColors.option.color!==buttonStyle.deny.color||hoverColors.background!==denyHover)throw new Error(`${name} approval menu must use one outer frame and the matching hover style: ${JSON.stringify({menuColors,hoverColors,denyHover})}`);
 await page.screenshot({path:artifact(`approval-menu-hover-${name}.png`),fullPage:false});
 // Intercept this fixture's click so testing the menu never grants a real approval.
 await page.evaluate(()=>document.querySelector('.approval-scoped').addEventListener('click',event=>{event.stopImmediatePropagation();window.__approvalMenuClicked=true},{capture:true,once:true}));
 await page.click('.approval-scoped');
 if(!await page.evaluate(()=>window.__approvalMenuClicked))throw new Error(`${name} approval option did not receive the click`);
 await page.click('.approval-menu-toggle');
 if(await page.locator('.approval-menu-toggle').getAttribute('aria-expanded')!=='false'||await page.locator('.approval-menu').isVisible())throw new Error(`${name} approval menu did not close`);
 for(const target of ['.approval-content','.thread-heading','#prompt']){
  await page.click('.approval-menu-toggle');
  await page.click(target);
  if(await page.locator('.approval-menu').isVisible()||await page.locator('.approval-menu-toggle').getAttribute('aria-expanded')!=='false'||await page.locator('.approval-card').count()!==1)throw new Error(`${name} outside click on ${target} must close only the menu and retain the approval`);
 }
 await page.click('.approval-menu-toggle');
 await page.keyboard.press('Escape');
 if(await page.locator('.approval-menu').isVisible()||await page.locator('.approval-menu-toggle').getAttribute('aria-expanded')!=='false')throw new Error(`${name} Escape must close the approval menu`);
 await page.click('.approval-menu-toggle');
 await page.click('#toggleSidePanel');
 await page.click('[data-side-panel-action="review"]');
 await page.waitForFunction(()=>!document.querySelector('#reviewPanelContent').hidden);
 await page.waitForSelector('#reviewMode:not([disabled])');
 await page.click('#reviewMode');
 await page.click('#reviewWrap');
 const result=await page.evaluate(()=>{
  const rect=s=>{const r=document.querySelector(s)?.getBoundingClientRect();return r&&{x:r.x,y:r.y,width:r.width,height:r.height}};
  const card=document.querySelector('[data-codex-approval-surface]');
  const activityIcon=document.querySelector('.activity-command-icon svg');
  const waiting=document.querySelector('.activity-summary-copy')?.textContent;
  const menuVisible=!card.querySelector('.approval-menu')?.hidden;
  return {card:rect('[data-codex-approval-surface]'),composer:rect('.composer'),buttons:[...card.querySelectorAll('button')].map(x=>x.textContent.trim()),commandLines:getComputedStyle(card.querySelector('.approval-command code')).webkitLineClamp,commandText:card.querySelector('.approval-command code')?.textContent,activityIcon:!!activityIcon,reviewFiles:document.querySelectorAll('.review-file').length,reviewAdds:document.querySelector('#reviewStats')?.textContent,waiting,menuVisible,reviewDrawer:!document.querySelector('#sidePanel').hidden,reviewWidth:rect('#sidePanel')?.width,reviewMode:document.querySelector('#changeList')?.dataset.mode,reviewWrap:document.querySelector('#changeList')?.classList.contains('wrap'),splitRows:document.querySelectorAll('.review-split-row').length,scrollWidth:document.documentElement.scrollWidth,innerWidth};
 });
 await page.screenshot({path:artifact(`${name}.png`),fullPage:false});
 console.log(name,JSON.stringify({...result,menuGeometry,arrowCenter,sendHover,stopHover,buttonStyle,menuColors,hoverColors,outsideClicksClose:true,escapeCloses:true,errors},null,2));
 if(!result.activityIcon||result.reviewFiles!==1||result.commandLines!=='none'||result.commandText!=='bun test tests/codex-surfaces.test.ts'||result.scrollWidth>result.innerWidth||errors.length)throw new Error(`${name} failed`);
 await page.close();
}
await run(1280,720,'surfaces-desktop');
await run(591,1100,'surfaces-mobile');
await run(390,844,'surfaces-phone');
await run(1280,720,'surfaces-dark','dark');
await browser.close();
