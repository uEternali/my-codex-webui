#!/usr/bin/env bun
// Native app-server fixture; no network, model requests, or executed tools.
import { createInterface } from 'node:readline';
import { appendFileSync, readFileSync } from 'node:fs';
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
const notify=(method,params)=>send({method,params});
const controls=()=>JSON.parse(readFileSync(process.env.ACTION_FIXTURE_CONTROL,'utf8'));
const raw='**Original Markdown**\n\n```js\nconsole.log("hello");\n```\n\n[Source](https://example.com)\n';
const threads=new Map(),emittedApprovals=new Set(),resolvedApprovals=new Set();let sequence=0,lastFinish=0;
for(const transport of ['ws','sse']){
 const id=`parent-${transport}`;
 threads.set(id,{id,name:`Actions fixture ${transport}`,cwd:process.env.CODEX_WEBUI_CWD,source:'local',canAcceptDirectInput:null,status:{type:'idle'},createdAt:1700000000,updatedAt:1700000060,turns:[
  {id:`${id}-first`,status:'completed',startedAt:1700000000,completedAt:1700000016,items:[{id:`${id}-question`,type:'userMessage',content:[{type:'text',text:'First question'}]},{id:`${id}-answer`,type:'agentMessage',phase:'final_answer',text:raw}]},
  {id:`${id}-second`,status:'completed',items:[{id:`${id}-later-question`,type:'userMessage',content:[{type:'text',text:'Later question'}]},{id:`${id}-later-answer`,type:'agentMessage',phase:'final_answer',text:'Later answer must not appear in the earlier branch.'}]}
 ]});
}
if(controls().historyCount){
 const count=controls().historyCount;
 threads.set('long-history',{id:'long-history',name:'Long history',cwd:process.env.CODEX_WEBUI_CWD,source:'local',canAcceptDirectInput:true,status:{type:'idle'},createdAt:1700000000,updatedAt:1700000060,turns:Array.from({length:count},(_,i)=>({id:`history-${i}`,status:'completed',items:[{id:`history-question-${i}`,type:'userMessage',content:[{type:'text',text:`History question ${i}`}]},{id:`history-answer-${i}`,type:'agentMessage',phase:'final_answer',text:`History answer ${i}`}]}))});
}
for(let index=0;index<(controls().archiveCount||0);index++){
 const id=`archived-fixture-${index}`;threads.set(id,{id,name:`Archived fixture ${index}`,archived:true,cwd:process.env.CODEX_WEBUI_CWD,source:'local',status:{type:'idle'},createdAt:1700000000,updatedAt:1700000050-index,turns:[]});
}
for(const project of controls().projects||[]){
 for(let index=0;index<project.count+(project.archivedCount||0);index++){
  const id=`${project.prefix}-${index}`,at=1800000000-index;
  threads.set(id,{id,name:`${project.prefix} chat ${index}`,cwd:project.cwd,archived:index>=project.count,source:'local',canAcceptDirectInput:null,status:{type:'idle'},createdAt:at,updatedAt:at,turns:[],...project.threads?.[index]});
 }
}
const tokenUsage=(thread,used)=>notify('thread/tokenUsage/updated',{threadId:thread.id,tokenUsage:{modelContextWindow:100000,last:{totalTokens:used}}});
const parentId=thread=>thread?.parentThreadId||thread?.source?.subAgent?.thread_spawn?.parent_thread_id||thread?.source?.subagent?.thread_spawn?.parent_thread_id;
const descendsFrom=(thread,ancestor)=>{const seen=new Set();let parent=parentId(thread);while(parent&&!seen.has(parent)){if(parent===ancestor)return true;seen.add(parent);parent=parentId(threads.get(parent))}return false};
const sourceKind=thread=>typeof thread.source==='object'?'subAgentThreadSpawn':thread.source==='local'?'vscode':thread.source;
const completeSide=thread=>{
 const turn=thread.turns.at(-1);if(!thread.ephemeral||turn?.status!=='inProgress'||thread.sideResponding||controls().sideHold)return;
 thread.sideResponding=true;
 setTimeout(()=>{
  if(!threads.has(thread.id)||turn.status!=='inProgress')return;
  notify('error',{threadId:thread.id,turnId:turn.id,willRetry:true,error:{message:'Reconnecting… 1/5 (HTTP 503)'}});
  const item={id:`side-answer-${turn.id}`,type:'agentMessage',text:''};turn.items.push(item);
  notify('item/started',{threadId:thread.id,turnId:turn.id,item});
  setTimeout(()=>{
   if(!threads.has(thread.id)||turn.status!=='inProgress')return;
   item.text='**Side answer** with inherited context.';
   notify('item/agentMessage/delta',{threadId:thread.id,turnId:turn.id,itemId:item.id,delta:item.text});
   notify('item/completed',{threadId:thread.id,turnId:turn.id,item});
   finish(thread);thread.sideResponding=false;
  },200);
 },200);
};
const finish=(thread,failed=false)=>{
 const turn=thread.turns.at(-1);if(turn?.status!=='inProgress')return;
 if(failed)notify('error',{threadId:thread.id,turnId:turn.id,willRetry:false,error:{message:'HTTP 503: compaction upstream unavailable'}});
 else if(turn.items[0]?.type==='contextCompaction'){
  turn.items[0].completedAtMs=Date.now();notify('item/completed',{threadId:thread.id,turnId:turn.id,item:turn.items[0]});tokenUsage(thread,8000);
 }
 turn.status=failed?'failed':'completed';turn.completedAt=Date.now()/1000;thread.status={type:'idle'};
 notify('turn/completed',{threadId:thread.id,turn});notify('thread/status/changed',{threadId:thread.id,status:thread.status});
};
setInterval(()=>{
 const command=controls();
 for(const [id,snapshot] of Object.entries(command.turnSnapshots||{})){
  const thread=threads.get(id);if(thread){thread.turns=snapshot;thread.status={type:snapshot.at(-1)?.status==='inProgress'?'active':'idle'};}
 }
 for(const thread of threads.values())if(thread.ephemeral)completeSide(thread);
 for(const id of command.resolvedApprovals||[])if(!resolvedApprovals.has(id)){resolvedApprovals.add(id);notify('serverRequest/resolved',{requestId:id})}
 for(const request of command.approvalRequests||[])if(!emittedApprovals.has(request.id)){emittedApprovals.add(request.id);send(request)}
 if(command.finish===lastFinish)return;lastFinish=command.finish;
 for(const thread of threads.values())if(thread.turns.at(-1)?.items[0]?.type==='contextCompaction')finish(thread);
},25);
createInterface({input:process.stdin}).on('line',line=>{
 const message=JSON.parse(line),p=message.params||{},method=message.method;if(!method){appendFileSync(process.env.ACTION_FIXTURE_LOG,JSON.stringify({type:'approvalResponse',...message})+'\n');return;}
 appendFileSync(process.env.ACTION_FIXTURE_LOG,JSON.stringify(message)+'\n');
 const reply=result=>send({id:message.id,result}),fail=text=>send({id:message.id,error:{code:-32602,message:text}});
 if(method==='initialize')return reply({codexHome:process.env.CODEX_HOME});if(method==='initialized')return;
 if(method==='model/list')return reply({data:controls().models||[{id:'fixture',model:'fixture',displayName:'Fixture',isDefault:true,defaultReasoningEffort:'low',supportedReasoningEfforts:[{reasoningEffort:'low',description:'Low'}]}]});
 if(method==='permissionProfile/list')return reply({data:[]});if(method==='account/read')return reply({account:null});
 if(method==='thread/list'){
  const command=controls();if(command.listRejectAncestor===p.ancestorThreadId&&p.ancestorThreadId)return fail('HTTP 503: subagent list unavailable');
  const kinds=p.sourceKinds?.length?p.sourceKinds:['cli','vscode'];
  const data=[...threads.values()].filter(thread=>!thread.ephemeral).filter(thread=>Boolean(thread.archived)===Boolean(p.archived)).filter(thread=>!command.omitForks||!thread.forkedFromId).filter(thread=>!p.cwd||thread.cwd===p.cwd).filter(thread=>kinds.includes(sourceKind(thread))).filter(thread=>!p.ancestorThreadId||descendsFrom(thread,p.ancestorThreadId)).filter(thread=>!p.parentThreadId||parentId(thread)===p.parentThreadId);
  data.sort((a,b)=>(p.sortDirection==='asc'?1:-1)*((a[p.sortKey==='created_at'?'createdAt':'updatedAt']||0)-(b[p.sortKey==='created_at'?'createdAt':'updatedAt']||0)));
  const start=Number(p.cursor)||0,limit=p.limit||50;
  const result={data:data.slice(start,start+limit).map(thread=>({...thread,status:{...thread.status,type:command.runningIds?.includes(thread.id)?'active':thread.status.type}})),nextCursor:command.repeatCursor?'repeat':start+limit<data.length?String(start+limit):null};
  const delay=command.listDelayByAncestor?.[p.ancestorThreadId];if(delay)setTimeout(()=>reply(result),delay);else reply(result);return;
 }
 if(method==='thread/start'){
  const complete=()=>{const id=`created-${++sequence}`,at=Date.now()/1000,thread={id,name:`Created chat ${sequence}`,cwd:p.cwd||process.env.CODEX_WEBUI_CWD,source:'local',ephemeral:Boolean(p.ephemeral),path:p.ephemeral?null:undefined,canAcceptDirectInput:true,status:{type:'idle'},createdAt:at,updatedAt:at,turns:[]};threads.set(id,thread);notify('thread/started',{thread});return reply({thread});};
  if(controls().startDelay)setTimeout(complete,controls().startDelay);else complete();return;
 }
 const thread=threads.get(p.threadId);
 if(method==='thread/unsubscribe'){if(controls().sideCloseReject)return fail('HTTP 503: side release unavailable');if(thread?.ephemeral){threads.delete(thread.id);notify('thread/closed',{threadId:thread.id})}return reply({status:'unsubscribed'});}
 if(method==='thread/read'){const result=()=>controls().readRejectId===p.threadId?fail('HTTP 503: subagent history unavailable'):thread?reply({thread:{...thread,...(controls().occupiedIds?.includes(thread.id)?{canAcceptDirectInput:false}:{}),status:{type:controls().runningIds?.includes(thread.id)?'active':thread.status.type}}}):fail('Thread not found');const delay=controls().readDelay?.[p.threadId];if(delay)setTimeout(result,delay);else result();return;}
 if(method==='thread/name/set'){
  if(controls().rename==='reject')return fail('HTTP 503: name service unavailable');
  thread.name=p.name;notify('thread/name/updated',{threadId:thread.id,name:p.name});return reply({});
 }
 if(method==='thread/archive'||method==='thread/unarchive'){
  if(controls().archive==='reject'||controls().archiveRejectId===p.threadId)return fail('HTTP 503: archive service unavailable');
  thread.archived=method==='thread/archive';thread.path=thread.archived?process.env.CODEX_HOME+'/archived_sessions/'+thread.id:process.env.CODEX_HOME+'/sessions/'+thread.id;
  notify(thread.archived?'thread/archived':'thread/unarchived',{threadId:thread.id});return reply(thread.archived?{}:{thread});
 }
 if(method==='thread/delete'){
  if(controls().delete==='reject'||controls().deleteRejectId===p.threadId)return fail('HTTP 503: deletion unavailable');
  const ids=new Set([p.threadId]);let changed;
  do{changed=false;for(const t of threads.values())if(ids.has(t.parentThreadId)&&!ids.has(t.id)){ids.add(t.id);changed=true;}}while(changed);
  for(const id of ids){threads.delete(id);notify('thread/deleted',{threadId:id});}return reply({});
 }
 if(method==='thread/resume'){const complete=()=>{if(controls().occupiedIds?.includes(p.threadId))return fail(`thread ${p.threadId} already has an active writer`);if(controls().resumeReject)return fail('HTTP 503: resume unavailable');thread.canAcceptDirectInput=true;tokenUsage(thread,40000);reply({thread:p.excludeTurns?{...thread,turns:[]}:thread});};if(controls().resumeDelay)setTimeout(complete,controls().resumeDelay);else complete();return;}
 if(method==='thread/goal/get')return reply({goal:null});
 if(method==='thread/turns/list'){
  const data=[...(thread?.turns||[])].reverse(),start=Number(p.cursor)||0,limit=p.limit||data.length||1;
  return reply({data:data.slice(start,start+limit),nextCursor:start+limit<data.length?String(start+limit):null});
 }
 if(method==='thread/compact/start'){
  if(controls().compact==='reject')return fail('HTTP 503: could not start compaction');
  if(thread.status.type==='active')return fail('Task already running');
  if(controls().compact==='lost')return;
  if(controls().compact==='delayed-reply')setTimeout(()=>reply({}),1200);else reply({});
  setTimeout(()=>{
   const turn={id:`compact-${++sequence}`,status:'inProgress',startedAt:Date.now()/1000,items:[]};
   thread.turns.push(turn);thread.status={type:'active'};
   notify('turn/started',{threadId:thread.id,turn});notify('thread/status/changed',{threadId:thread.id,status:thread.status});
   const item={id:`compact-item-${sequence}`,type:'contextCompaction'};turn.items.push(item);
   notify('item/started',{threadId:thread.id,turnId:turn.id,item});
   if(controls().compact==='fail')setTimeout(()=>finish(thread,true),200);
  },400);
  return;
 }
 if(method==='thread/fork'){
  if(controls().fork==='reject')return fail('HTTP 503: could not create branch');
  const index=p.lastTurnId?thread.turns.findIndex(turn=>turn.id===p.lastTurnId):thread.turns.length-1;
  if(p.lastTurnId&&(index<0||thread.turns[index].status==='inProgress'))return fail('Invalid branch boundary');
  const fork={...structuredClone(thread),id:`branch-${++sequence}`,name:`Branch ${sequence}`,forkedFromId:thread.id,parentThreadId:null,turns:structuredClone(thread.turns.slice(0,index+1)),canAcceptDirectInput:true,ephemeral:Boolean(p.ephemeral),path:p.ephemeral?null:undefined,status:{type:'idle'}};
  threads.set(fork.id,fork);notify('thread/started',{thread:fork});setTimeout(()=>reply({thread:fork}),180);return;
 }
 if(method==='turn/start'){
  const turn={id:`running-${++sequence}`,status:'inProgress',items:[{id:`running-user-${sequence}`,type:'userMessage',clientId:p.clientUserMessageId,content:p.input}]};
  thread.turns.push(turn);thread.status={type:'active'};notify('turn/started',{threadId:thread.id,turn});return reply({turn});
 }
 if(method==='turn/interrupt'){
  const turn=thread.turns.at(-1);turn.status='interrupted';thread.status={type:'idle'};notify('turn/completed',{threadId:thread.id,turn});notify('thread/status/changed',{threadId:thread.id,status:thread.status});return reply({});
 }
 reply({data:[]});
});
