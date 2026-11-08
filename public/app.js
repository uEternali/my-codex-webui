import { attachmentInput, createAttachmentController } from './attachments.js';
import { renderUserAttachments, userMessageContent } from './user-attachments.js';
import { DEFAULT_TURN_PAGE_SIZE, applyComposerSuggestion, createLatestRequestGate, createTurnWindow, filterAppModels, getComposerAutocomplete, resolveComposerPlaceholder, selectModelState } from './ui-core.js';
import { agentMessageText, renderAssistantMarkdown, renderItemImages } from './rendering.js';
import { codexIcon, hydrateCodexIcons } from './codex-icons.js';
import { codexInterfaceMark } from './codex-brand.js';
import { createDomI18n, createI18n } from './i18n.js';
import { buildApprovalModel, createReviewPreferences, parseUnifiedDiff, permissionRows, splitDiffHunk, summarizeActivity, unifiedDiffFromFileChanges } from './codex-surfaces.js';
import { browserSandboxFor, normalizeBrowserUrl } from './browser-panel.js';
import { THREAD_NOT_FOUND, bridgeErrorCode, createBridgeError, threadInputErrorMessage } from './bridge-errors.js';
import { isApprovalRequest, PendingRequestStore } from './approval-state.js';
import { createGoalController } from './goals.js';
import { parseGoalCommand } from './goal-state.js';
import { initializeTurnPresentation, settleActivityItem, showTurnError, updateTurnPresentation } from './turn-status.js';
import { orderTimeline } from './conversation-order.js';
import { createClientMessageId, SteeringStore } from './steering-state.js';
import { copyReplyText, replyText } from './reply-actions.js';
import { createThreadControls } from './thread-controls.js';
import { createProjectControls } from './project-controls.js';
import lottie from 'lottie-web/build/player/lottie_light.js';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
globalThis.__renderAssistantMarkdown = renderAssistantMarkdown;
const $ = (s) => document.querySelector(s);
const i18n=globalThis.__codexWebuiI18n||createI18n();
globalThis.__codexWebuiI18n=i18n;
globalThis.__codexWebuiDomI18n=globalThis.__codexWebuiDomI18n||createDomI18n(i18n);
const t=(message,values)=>i18n.t(message,values);
const state = { ws:null, events:null, transport:'connecting', wsFallbackTimer:null, rpcId:1, pending:new Map(), threads:[], active:null, models:[], selectedModel:'', workspaceContext:null, workspaceSelected:false, threadLoading:false, projectless:false, composerMode:'local', planMode:false, permissionMode:localStorage.getItem('codex-webui-permission-mode')||'default', permissionProfiles:[], permissionVisibility:{autoReview:true,fullAccess:localStorage.getItem('codex-webui-permission-full-access')!=='false'}, goalMode:false, backgroundAgentsVisible:false, cloudStartingState:null, placeholderText:null, composerMentions:[], turnWindow:null, tokenUsage:new Map(), items:new Map(), turns:new Map(), activities:new Map(), activityItems:new Map(), sideTasks:new Map(), dividers:new Map(), changes:new Map(), requestCards:new Map(), serverRequests:new PendingRequestStore(), motion:new Map(), turnDiffs:new Map(), activeReview:null, account:null, connected:false, initializing:true, config:{home:'',defaultCwd:'',projectless:false} };
const approvalContexts=new WeakMap();
let steeringStorage;try{steeringStorage=sessionStorage}catch{}
const pendingSteers=new SteeringStore(steeringStorage),steeringSubmissions=new Map(),steeringInterrupts=new Map();
const compactionRequests=new Map(),forkRequests=new Set(),promptAdmissions=new Set();
let composerAttachments, goalControls, threadControls, projectControls;
let folderBrowse={path:'~',parent:null,selected:null};
const reviewPreferences=createReviewPreferences(JSON.parse(localStorage.getItem('codex-webui-review-preferences')||'{}'));
let reviewPatchState='undo';
let sidePanelReturnFocus=null,summaryPanelReturnFocus=null,imageViewerReturnFocus=null;
let bottomPanelLastView=null;
let sidebarLayoutMobile=null;
let pendingFullAccessAction='select';
let settingsMobileLayout=matchMedia('(max-width:480px)').matches;
const createTerminalState=(hostId,panelId)=>({hostId,panelId,term:null,fit:null,ws:null,resizeObserver:null,reconnectTimer:null});
const terminalStates={bottom:createTerminalState('terminalHost','bottomPanel'),side:createTerminalState('sideTerminalHost','sidePanel')};
const browserState={history:[],index:-1,loadTimer:null,loadRequest:0};
const accountRequestGate=createLatestRequestGate();
const workspaceContextRequestGate=createLatestRequestGate();
const permissionProfileRequestGate=createLatestRequestGate();
const autocompleteState={match:null,items:[],selected:0,requestId:0,message:''};
const threadOpenRequestGate=createLatestRequestGate();
const SIDEBAR_PROJECT_EXPANSION_KEY='codex-webui-sidebar-project-expansion';
const sidebarProjectExpansion=(()=>{try{return JSON.parse(localStorage.getItem(SIDEBAR_PROJECT_EXPANSION_KEY)||'{}')}catch{return{}}})();
const ACTIVE_THREAD_SYNC_ACTIVE_MS=800,ACTIVE_THREAD_SYNC_IDLE_MS=2400,THREAD_LIST_POLL_MS=3000;
let activeThreadSyncTimer=null,activeThreadSyncGeneration=0,activeThreadSyncInFlight=false,activeThreadSyncSignature='',threadListTimer=null,threadListInFlight=false,threadListSignature='',initialLoadGeneration=0;

const icons = {
  chevron:codexIcon('chevronRight','activity-chevron'),
  terminal:codexIcon('terminal'),
  file:codexIcon('file'),
  search:codexIcon('search'),
  tool:codexIcon('wrench'),
  check:codexIcon('check'),
};
hydrateCodexIcons();
$('#windowCodexMark').innerHTML=codexInterfaceMark('window-codex-mark');
$('#emptyCodexMark').innerHTML=codexInterfaceMark('empty-codex-mark');

const WS_CONNECT_TIMEOUT_MS=5000;
function transportSwitchError(){const error=new Error('Bridge transport changed');error.silentTransportSwitch=true;return error}
function clearWsFallbackTimer(){clearTimeout(state.wsFallbackTimer);state.wsFallbackTimer=null}
function rejectWebSocketPending(){for(const pending of state.pending.values())pending.reject(transportSwitchError());state.pending.clear()}
async function postBridge(path,payload){const response=await fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload),cache:'no-store'}),data=await response.json().catch(()=>({}));if(!response.ok){const error=createBridgeError(data.error||data.message||`Codex bridge request failed (HTTP ${response.status})`,data.code);error.httpStatusCode=response.status;throw error}return data}
function connectSse(){
  if(state.events)return;
  state.transport='sse';state.connected=false;setStatus('connecting','Connecting to Codex');
  const events=new EventSource('/api/events');state.events=events;
  events.onmessage=event=>{try{handle(JSON.parse(event.data))}catch{}};
  events.onerror=()=>{if(state.events===events){state.connected=false;setStatus('connecting','Connecting to Codex')}};
}
function fallbackToSse(ws){
  if(state.transport==='sse'||(ws&&state.ws!==ws))return;
  clearWsFallbackTimer();rejectWebSocketPending();state.connected=false;
  if(ws){ws.onopen=ws.onmessage=ws.onerror=ws.onclose=null;try{ws.close()}catch{}}
  state.ws=null;connectSse();
}
function connect(){
  if(state.transport==='sse'||state.ws)return;
  const proto=location.protocol==='https:'?'wss:':'ws:';
  let ws;
  try{ws=new WebSocket(`${proto}//${location.host}/ws`)}catch{fallbackToSse();return}
  state.transport='ws';state.ws=ws;
  const fallback=()=>fallbackToSse(ws);
  state.wsFallbackTimer=setTimeout(fallback,WS_CONNECT_TIMEOUT_MS);
  ws.onopen=()=>{if(state.ws===ws)setStatus('connecting','Connecting to Codex')};
  ws.onmessage=(event)=>{if(state.ws!==ws)return;try{const message=JSON.parse(event.data);clearWsFallbackTimer();handle(message)}catch{fallback()}};
  ws.onerror=fallback;ws.onclose=fallback;
}
function rpc(method,params={}){
  const id=state.rpcId++;
  if(state.transport==='sse')return postBridge('/api/rpc',{id,method,params}).then(message=>{if(message.type!=='rpc/result')throw createBridgeError(message.error||'Codex bridge request failed',message.code);return message.result});
  if(state.ws?.readyState===WebSocket.OPEN){try{state.ws.send(JSON.stringify({type:'rpc',id,method,params}));return new Promise((resolve,reject)=>state.pending.set(id,{resolve,reject}))}catch{fallbackToSse(state.ws);return Promise.reject(transportSwitchError())}}
  return Promise.reject(transportSwitchError());
}
function respondToCodex(requestId,result,error){
  if(state.transport==='sse')return postBridge('/api/codex/respond',{requestId,result,error});
  if(state.ws?.readyState===WebSocket.OPEN){try{state.ws.send(JSON.stringify(error?{type:'codex/error',requestId,error}:{type:'codex/response',requestId,result}));return Promise.resolve()}catch{fallbackToSse(state.ws);return Promise.reject(transportSwitchError())}}
  return Promise.reject(transportSwitchError());
}
function handle(message){
  if(message.type==='bridge/status'){
    if(message.status==='connected'){const shouldLoad=!state.connected;state.connected=true;setStatus('connected','Codex connected');if(shouldLoad){loadInitial();threadControls?.connected();requestTaskNotifyPermission()}}
    else{state.connected=false;setStatus('connecting','Connecting to Codex')}
    return;
  }
  if(message.type==='rpc/result'||message.type==='rpc/error'){
    const p=state.pending.get(message.id);if(!p)return;state.pending.delete(message.id);
    message.type==='rpc/result'?p.resolve(message.result):p.reject(createBridgeError(message.error,message.code));return;
  }
  if(message.type==='codex/notification') onNotification(message.payload.method,message.payload.params||{});
  if(message.type==='codex/request') onServerRequest(message.payload);
  if(message.type==='codex/requests') onServerRequests(message.requests);
}
function setStatus(kind,text){
  $('#statusDot').className='status-dot'+(kind==='connected'?' connected':kind==='error'?' error':'');
  $('#statusText').textContent=t(text||kind);
}
async function loadInitial(refreshAccount=false){
  const generation=++initialLoadGeneration;
  if(state.initializing)globalThis.__codexWebuiStartup?.begin();
  try{const [models,threads,profiles]=await Promise.all([rpc('model/list',{limit:50}),rpc('thread/list',{limit:50,sortKey:'recency_at',sortDirection:'desc'}),rpc('permissionProfile/list',{cwd:permissionProfileCwd(),limit:100}).catch(()=>({data:[]})),loadAccount(refreshAccount)]);
    if(!state.connected||generation!==initialLoadGeneration)return;
    state.models=filterAppModels(models.data||[]);renderModels();applyThreadSummaries(threads.data||[]);setPermissionProfiles(profiles.data||[]);scheduleThreadListRefresh();const requestedThread=threadRouteId();if(requestedThread&&state.active?.id!==requestedThread)await openThread(requestedThread,null,{updateRoute:false});
    if(state.connected&&generation===initialLoadGeneration&&state.initializing){state.initializing=false;if($('#emptyState'))showEmpty();globalThis.__codexWebuiStartup?.finish();const initialSettingsPage=settingsRoutePage();if(initialSettingsPage)showSettings(initialSettingsPage,{updateRoute:false})}
  }catch(e){if(generation!==initialLoadGeneration||e?.silentTransportSwitch)return;if(state.initializing)globalThis.__codexWebuiStartup?.fail(e,()=>{if(state.connected)void loadInitial(refreshAccount);else location.reload()});else toast(e.message)}
}
async function loadAccount(refresh=false){
  const requestId=accountRequestGate.next();
  try{const response=await fetch(`/api/account${refresh?'?refresh=1':''}`,{cache:'no-store'}),account=await response.json();if(!response.ok)throw new Error(account.error||'Cannot load account');if(!accountRequestGate.isCurrent(requestId))return;state.account=account;renderAccount(account)}catch{if(accountRequestGate.isCurrent(requestId))renderAccount({displayName:null,avatarUrl:null,planType:null,initials:'?'})}
}
function renderAccount(account){
  state.account=account;
  const displayName=account?.displayName?.trim()||t('Settings'),initials=account?.initials?.trim()||'?',type=account?.type||'unknown',plan=account?.planType?`${account.planType.charAt(0).toUpperCase()}${account.planType.slice(1)} plan`:type==='apiKey'?t('API key mode'):type==='amazonBedrock'?'Amazon Bedrock':'';
  const profileMenuAvailable=type==='chatgpt';
  $('#accountName').textContent=displayName;$('#accountMenuName').textContent=displayName;$('#settingsAccountName').textContent=displayName;$('#accountFooterMeta').textContent='';$('#accountMenuSubtitle').textContent=plan;$('#settingsAccountMeta').textContent=plan||t('Codex account');
  $('#accountButton').setAttribute('aria-label',profileMenuAvailable?'Open profile menu':'Open settings');
  const avatarUrl=profileMenuAvailable&&typeof account?.avatarUrl==='string'&&account.avatarUrl.startsWith('/api/account/avatar')?account.avatarUrl:'',profileAvatars=[$('#accountMenuAvatar'),$('#settingsAccountAvatar')],footerAvatar=$('#accountAvatar'),profileAvatarClass=avatar=>`account-avatar${avatar.id==='accountMenuAvatar'?' account-menu-avatar':''}`;for(const avatar of profileAvatars){avatar.dataset.imageUrl=avatarUrl;avatar.className=`${profileAvatarClass(avatar)} account-initials`;avatar.textContent=initials}
  if(profileMenuAvailable){footerAvatar.dataset.imageUrl=avatarUrl;footerAvatar.className='account-avatar account-initials';footerAvatar.textContent=initials;profileAvatars.unshift(footerAvatar)}else{footerAvatar.dataset.imageUrl='';footerAvatar.className='account-avatar account-settings-icon';footerAvatar.innerHTML=codexIcon('wrench')}
  if(avatarUrl){const image=new Image;image.alt='';image.src=`${avatarUrl}?v=${Date.now()}`;image.onload=()=>{for(const avatar of profileAvatars){if(avatar.dataset.imageUrl!==avatarUrl)continue;avatar.className=profileAvatarClass(avatar);avatar.replaceChildren(image.cloneNode())}};image.onerror=()=>{for(const avatar of profileAvatars){if(avatar.dataset.imageUrl!==avatarUrl)continue;avatar.className=`${profileAvatarClass(avatar)} account-initials`;avatar.textContent=initials}}}
  if(!profileMenuAvailable)toggleAccountMenu(false);
  const apiMode=!profileMenuAvailable;$('#accountProfile').hidden=apiMode;$('#accountUsage').hidden=apiMode;$('#accountLogout').hidden=apiMode;
  const accountSettingsPage=$('[data-settings-page="profile"]');if(accountSettingsPage){accountSettingsPage.dataset.settingsAvailable=String(!apiMode);if(apiMode&&accountSettingsPage.classList.contains('active'))setSettingsPage('general-settings');filterSettingsNavigation($('#settingsSearch')?.value||'')}
  syncPermissionSettings();syncPermissionControl();
}
function toggleAccountMenu(force){const menu=$('#accountMenu'),open=force??menu.hidden;menu.hidden=!open;$('#accountButton').setAttribute('aria-expanded',String(open))}
const settingsPageAliases={general:'general-settings',account:'profile',keyboard:'keyboard-shortcuts'};
const settingsPages={
  'general-settings':{title:'General'},appearance:{title:'Appearance',rows:[['Theme','System'],['Language','System default'],['Interface scale','Default']]},agent:{title:'Configuration'},profile:{title:'Profile'},'keyboard-shortcuts':{title:'Keyboard shortcuts'},
  'plugins-settings':{title:'Plugins',rows:[['Installed plugins','None'],['Plugin sources','Not configured']]},'skills-settings':{title:'Skills',rows:[['Installed skills','Not configured']]},'browser-use':{title:'Browser',rows:[['Browser access','Not configured'],['Network access','Inherited from permissions']]},'computer-use':{title:'Computer use',rows:[['Computer use','Not configured']]},
  connections:{title:'Connections',rows:[['Connected services','None']]},'cloud-settings':{title:'Cloud preferences',rows:[['Diff view','Unified'],['Branch format','Default']]},'cloud-environments':{title:'Cloud environments',rows:[['Environments','None']]},'code-review':{title:'Code review',rows:[['Review instructions','Not configured']]},'git-settings':{title:'Git',rows:[['Git integration','System default']]},'hooks-settings':{title:'Hooks',rows:[['Configured hooks','None']]},worktrees:{title:'Worktrees',rows:[['Worktree behavior','Default']]},'data-controls':{title:'Archived chats',rows:[['Archived chats','None']]},
};
function normalizeSettingsPage(page='general-settings'){const candidate=settingsPageAliases[page]||page;return settingsPages[candidate]?candidate:'general-settings'}
function settingsRoutePage(pathname=location.pathname){const match=pathname.match(/^\/settings(?:\/([^/]+))?\/?$/);return match?normalizeSettingsPage(match[1]||'general-settings'):null}
function settingsPlaceholderRows(page){if(page==='agent')return[['Model',modelDisplay(selectedModel())],['Reasoning effort',reasoningLabel($('#effortSelect').value)],['Approval',selectedPermission().label],['Web search','Automatic']];return settingsPages[page]?.rows||[]}
function renderSettingsPlaceholder(page){const definition=settingsPages[page],title=$('#settingsPlaceholderTitle'),description=$('#settingsPlaceholderDescription'),rows=$('#settingsPlaceholderRows');title.textContent=t(definition.title);description.hidden=true;description.textContent='';rows.replaceChildren();if(page==='data-controls'){const button=document.createElement('button');button.type='button';button.className='archive-settings-shortcut';button.innerHTML=codexIcon('archive');button.append(document.createTextNode(t('Open archive')));button.onclick=()=>{closeSettings();setSidebarOpen(true);threadControls?.showArchives()};rows.append(button);return}for(const [label,value] of settingsPlaceholderRows(page)){const row=document.createElement('div');row.className='settings-row settings-readonly-row';const copy=document.createElement('span'),strong=document.createElement('strong'),status=document.createElement('span');strong.textContent=t(label);copy.append(strong);status.textContent=t(value);row.append(copy,status);rows.append(row)}}
function setSettingsPage(page='general-settings',{updateRoute=true}={}){const selected=normalizeSettingsPage(page),contentPage=['general-settings','profile','keyboard-shortcuts'].includes(selected)?selected:'placeholder';for(const button of document.querySelectorAll('[data-settings-page]'))button.classList.toggle('active',button.dataset.settingsPage===selected);for(const content of document.querySelectorAll('[data-settings-content]'))content.hidden=content.dataset.settingsContent!==contentPage;if(contentPage==='placeholder')renderSettingsPlaceholder(selected);$('#settingsPageTitle').textContent=t(settingsPages[selected].title);$('#settingsContent')?.scrollTo({top:0});if(updateRoute&&settingsRoutePage())history.replaceState({...history.state,codexWebuiSettings:true},'',`/settings/${selected}${location.search}${location.hash}`)}
function filterSettingsNavigation(query=''){const normalized=query.trim().toLocaleLowerCase(),clear=$('#clearSettingsSearch');let visible=0;if(clear)clear.hidden=!normalized;for(const group of document.querySelectorAll('[data-settings-group]')){let groupVisible=0;for(const button of group.querySelectorAll('[data-settings-page]')){const available=button.dataset.settingsAvailable!=='false',matches=!normalized||button.textContent.toLocaleLowerCase().includes(normalized);button.hidden=!available||!matches;if(!button.hidden){groupVisible++;visible++}}group.hidden=groupVisible===0}$('#settingsNavEmpty').hidden=visible!==0}
function clearSettingsSearch(){const input=$('#settingsSearch');input.value='';filterSettingsNavigation();input.focus()}
function showSettingsMobileNavigation(){const dialog=$('#settingsDialog');dialog.dataset.mobilePage='false';requestAnimationFrame(()=>$('#settingsSearch').focus())}
function syncSettingsResponsiveLayout(){const mobile=matchMedia('(max-width:480px)').matches;if(mobile===settingsMobileLayout)return;settingsMobileLayout=mobile;const dialog=$('#settingsDialog');if(dialog.open)dialog.dataset.mobilePage=String(mobile)}
function hideSettings(){const dialog=$('#settingsDialog');if(dialog.open)dialog.close();document.body.classList.remove('settings-open')}
function closeSettings(){if(settingsRoutePage()){if(typeof history.state?.codexSettingsReturnPath==='string'){history.back();return}history.replaceState(history.state,'',`/${location.search}${location.hash}`);hideSettings();return}hideSettings()}
$('#closeSettingsNav').onclick=closeSettings;$('#settingsMobileBack').onclick=showSettingsMobileNavigation;for(const button of document.querySelectorAll('.settings-page .settings-mobile-back'))button.onclick=showSettingsMobileNavigation;$('#settingsSearch').oninput=event=>filterSettingsNavigation(event.currentTarget.value);$('#clearSettingsSearch').onclick=clearSettingsSearch;$('#settingsSearch').onkeydown=event=>{if(event.key==='Escape'&&event.currentTarget.value){event.preventDefault();clearSettingsSearch()}};addEventListener('resize',syncSettingsResponsiveLayout);addEventListener('popstate',()=>void restoreLocation());
function showSettings(page='general-settings',{updateRoute=true}={}){toggleAccountMenu(false);syncPermissionSettings();$('#settingsPermissionValue').textContent=t(selectedPermission().label);$('#settingsProjectValue').textContent=state.projectless?t('No project'):shortPath(state.active?.cwd||$('#projectPath').textContent);$('#settingsSearch').value='';filterSettingsNavigation();setSettingsPage(page,{updateRoute});const dialog=$('#settingsDialog'),mobile=matchMedia('(max-width:480px)').matches;settingsMobileLayout=mobile;dialog.dataset.mobilePage=String(mobile);if(!dialog.open)dialog.show();document.body.classList.add('settings-open');requestAnimationFrame(()=>{const target=mobile?$('#settingsSearch'):document.querySelector('.settings-nav-back');target?.focus()})}
function openSettings(page='general-settings'){const selected=normalizeSettingsPage(page),current=settingsRoutePage();if(!current){history.pushState({...history.state,codexWebuiSettings:true,codexSettingsReturnPath:location.pathname+location.search+location.hash},'',`/settings/${selected}${location.search}${location.hash}`)}else if(current!==selected){history.replaceState({...history.state,codexWebuiSettings:true},'',`/settings/${selected}${location.search}${location.hash}`)}showSettings(selected,{updateRoute:false})}
const reasoningLabels={none:'None',minimal:'Minimal',low:'Low',medium:'Medium',high:'High',xhigh:'Extra High',max:'Max',ultra:'Ultra'};
function reasoningLabel(value){return reasoningLabels[value]||String(value||'Medium')}
function modelDisplay(model,stripPrefix=false){const value=String(model?.displayName||model?.model||state.selectedModel||'Select model').trim();if(!stripPrefix)return value;return value.replace(/^GPT-/i,'').trim()||value}
function selectedModel(){return state.models.find(x=>x.model===state.selectedModel)}
function renderModels(){
  const saved=localStorage.getItem('codex-webui-model'),selection=selectModelState(state.models,saved);state.selectedModel=selection.model;
  updateEfforts(selection.effort);syncModelLabel();renderModelMenuMain();
}
function chooseModel(model,keepOpen=false){const previous=$('#effortSelect').value;state.selectedModel=model;localStorage.setItem('codex-webui-model',model);updateEfforts(previous);syncModelLabel();if(keepOpen)renderModelMenuMain();else closeModelMenu();toast(`Model: ${modelDisplay(selectedModel())}`)}
function syncModelLabel(){const model=selectedModel();$('#modelLabel').textContent=modelDisplay(model,true);$('#effortLabel').textContent=reasoningLabel($('#effortSelect').value)}
function updateEfforts(preferred){
  const model=selectedModel(),effort=$('#effortSelect');effort.innerHTML='';
  const supported=model?.supportedReasoningEfforts||[{reasoningEffort:'medium'}],values=supported.map(item=>item.reasoningEffort).filter(Boolean),saved=localStorage.getItem(`codex-webui-effort:${state.selectedModel}`),selected=[saved,preferred,model?.defaultReasoningEffort,values[0],'medium'].find(value=>values.includes(value))||'medium';
  for(const value of values.length?values:['medium']){const option=document.createElement('option');option.value=value;option.textContent=value;option.selected=value===selected;effort.append(option)}
  $('#effortLabel').textContent=reasoningLabel(effort.value);
}
function contextUsageValue(tokenUsage){const contextWindow=Number(tokenUsage?.modelContextWindow),totalTokens=Number(tokenUsage?.last?.totalTokens);if(!Number.isFinite(contextWindow)||contextWindow<=0||!Number.isFinite(totalTokens)||totalTokens<0)return null;const usedTokens=Math.min(totalTokens,contextWindow),percent=usedTokens/contextWindow*100;return Number.isFinite(percent)?{percent,usedTokens,contextWindow,remainingTokens:Math.max(contextWindow-usedTokens,0)}:null}
function renderContextUsage(){const indicator=$('#contextUsage'),usage=state.active?.id?contextUsageValue(state.tokenUsage.get(state.active.id)):null;if(!indicator)return;if(!usage){indicator.hidden=true;indicator.removeAttribute('data-tooltip');return}const percent=Math.max(0,Math.min(usage.percent,100)),rounded=Math.round(percent),remaining=Math.max(0,100-rounded),usedThousands=Math.round(usage.usedTokens/1000),windowThousands=Math.round(usage.contextWindow/1000),status=rounded>=50?`${rounded}% full`:`${rounded}% used (${remaining}% left)`;indicator.hidden=false;indicator.style.setProperty('--context-percent',String(percent));indicator.setAttribute('aria-label',`Context usage: ${rounded}%`);indicator.dataset.tooltip=`Context window:\n${status}\n${usedThousands}k / ${windowThousands}k tokens used`}
function menuTitle(text,back=false){return `<div class="model-menu-title-row">${back?`<button type="button" class="model-menu-back" id="modelMenuBack" aria-label="Back">${codexIcon('chevronLeft')}</button>`:''}<div class="model-menu-title">${escapeHtml(text)}</div></div>`}
function renderModelMenuMain(){const menu=$('#modelMenu'),model=selectedModel(),effort=$('#effortSelect');menu.innerHTML=`<div class="model-menu-view model-menu-view-main">${menuTitle('Reasoning')}<div class="model-menu-list" data-model-menu-efforts></div><div class="model-menu-separator"></div><button type="button" class="model-submenu-button" id="modelSubmenuButton"><span>Model</span><span class="model-submenu-value">${escapeHtml(modelDisplay(model))}</span>${codexIcon('chevronRight')}</button></div>`;const list=menu.querySelector('[data-model-menu-efforts]');for(const option of effort.options){const button=document.createElement('button');button.type='button';button.className='model-effort-row';button.dataset.value=option.value;button.setAttribute('aria-checked',String(option.selected));button.innerHTML=`<span data-i18n-ignore>${escapeHtml(reasoningLabel(option.value))}</span><span class="model-check">${option.selected?codexIcon('check'):''}</span>`;button.onclick=()=>chooseEffort(option.value);list.append(button)}menu.querySelector('#modelSubmenuButton').onclick=renderModelSubmenu}
function renderModelSubmenu(){const menu=$('#modelMenu');menu.innerHTML=`<div class="model-menu-view model-menu-view-models">${menuTitle('Model',true)}<div class="model-menu-list model-list"></div></div>`;menu.querySelector('#modelMenuBack').onclick=renderModelMenuMain;const list=menu.querySelector('.model-list');for(const model of state.models){const button=document.createElement('button');button.type='button';button.className='model-option';button.role='menuitemradio';button.dataset.model=model.model;button.setAttribute('aria-checked',String(model.model===state.selectedModel));button.innerHTML=`<span class="model-option-copy"><strong>${escapeHtml(modelDisplay(model))}</strong>${model.description?`<small>${escapeHtml(model.description)}</small>`:''}</span><span class="model-check">${model.model===state.selectedModel?codexIcon('check'):''}</span>`;button.onclick=()=>chooseModel(model.model);list.append(button)}}
function chooseEffort(value){const effort=$('#effortSelect');if(![...effort.options].some(option=>option.value===value))return;effort.value=value;$('#effortLabel').textContent=reasoningLabel(value);localStorage.setItem(`codex-webui-effort:${state.selectedModel}`,value);closeModelMenu();toast(`Reasoning: ${reasoningLabel(value)}`)}
function openModelMenu(view='main'){if(view==='models')renderModelSubmenu();else renderModelMenuMain();$('#modelMenu').hidden=false;$('#modelButton').setAttribute('aria-expanded','true')}
function toggleModelMenu(){const menu=$('#modelMenu');if(menu.hidden)openModelMenu();else closeModelMenu()}
function closeModelMenu(){const menu=$('#modelMenu');menu.hidden=true;$('#modelButton').setAttribute('aria-expanded','false')}
const permissionModes={
  default:{kind:'legacy',label:'Ask for approval',description:'Always ask for permission before editing external files or using the internet',icon:'shield',approvalPolicy:'on-request',approvalsReviewer:'user',sandbox:'workspace-write'},
  'guardian-approvals':{kind:'legacy',label:'Approve for me',description:'Only ask for actions detected as potentially unsafe',icon:'shield',approvalPolicy:'on-request',approvalsReviewer:'auto_review',sandbox:'workspace-write'},
  'full-access':{kind:'legacy',label:'Full access',description:'Unrestricted access to the internet and any file on your computer',icon:'terminal',approvalPolicy:'never',approvalsReviewer:'user',sandbox:'danger-full-access'},
};
const PERMISSION_PROFILE_PREFIX='profile:';
const RESERVED_PERMISSION_PROFILE_IDS=new Set(['default','guardian-approvals','full-access','custom']);
function permissionProfileCwd(){if(state.projectless)return null;return state.active?.cwd||state.workspaceContext?.cwd||null}
function permissionProfileId(mode=state.permissionMode){return String(mode||'').startsWith(PERMISSION_PROFILE_PREFIX)?String(mode).slice(PERMISSION_PROFILE_PREFIX.length):null}
function autoReviewSupported(){return state.account?.type==='chatgpt'}
function permissionModeDefinition(mode=state.permissionMode){if(permissionModes[mode])return{mode,...permissionModes[mode]};const profileId=permissionProfileId(mode),profile=profileId&&state.permissionProfiles.find(item=>item.id===profileId);return profile?{kind:'profile',mode,profileId,label:profile.id,description:profile.description||'Custom permission profile',icon:'file',allowed:profile.allowed!==false}:null}
function permissionModeAvailable(mode=state.permissionMode){const selected=permissionModeDefinition(mode);if(!selected||selected.allowed===false)return false;if(mode==='guardian-approvals')return autoReviewSupported();if(mode==='full-access')return state.permissionVisibility.fullAccess;return true}
function normalizePermissionMode(){if(permissionModeAvailable())return;state.permissionMode='default';localStorage.setItem('codex-webui-permission-mode','default')}
function selectedPermission(){normalizePermissionMode();return permissionModeDefinition()||{mode:'default',...permissionModes.default}}
function setPermissionProfiles(profiles=[]){const seen=new Set;state.permissionProfiles=(Array.isArray(profiles)?profiles:[]).flatMap(profile=>{if(!profile||typeof profile.id!=='string')return[];const id=profile.id.trim(),key=id.toLocaleLowerCase();if(!id||id.startsWith(':')||RESERVED_PERMISSION_PROFILE_IDS.has(key)||seen.has(key))return[];seen.add(key);return[{id,description:typeof profile.description==='string'?profile.description:'',allowed:profile.allowed!==false}]});normalizePermissionMode();syncPermissionControl()}
async function loadPermissionProfiles(){if(!state.connected)return;const requestId=permissionProfileRequestGate.next();try{const result=await rpc('permissionProfile/list',{cwd:permissionProfileCwd(),limit:100});if(permissionProfileRequestGate.isCurrent(requestId))setPermissionProfiles(result.data||[])}catch{if(permissionProfileRequestGate.isCurrent(requestId))setPermissionProfiles([])}}
function permissionThreadPolicy(){const selected=selectedPermission();if(selected.kind==='profile')return{permissions:selected.profileId};return{approvalPolicy:selected.approvalPolicy,approvalsReviewer:selected.approvalsReviewer,sandbox:selected.sandbox}}
function permissionTurnPolicy(cwd){const selected=selectedPermission();if(selected.kind==='profile')return{permissions:selected.profileId,approvalPolicy:null,approvalsReviewer:null};const sandboxPolicy=selected.sandbox==='danger-full-access'?{type:'dangerFullAccess'}:{type:'workspaceWrite',writableRoots:cwd?[cwd]:[],networkAccess:false,excludeTmpdirEnvVar:false,excludeSlashTmp:false};return{permissions:null,approvalPolicy:selected.approvalPolicy,approvalsReviewer:selected.approvalsReviewer,sandboxPolicy}}
function renderPermissionMenu(){const list=$('#permissionOptions');if(!list)return;list.innerHTML='';const modes=['default'];if(autoReviewSupported())modes.push('guardian-approvals');if(state.permissionVisibility.fullAccess)modes.push('full-access');for(const profile of state.permissionProfiles)modes.push(`${PERMISSION_PROFILE_PREFIX}${profile.id}`);for(const mode of modes){const option=permissionModeDefinition(mode);if(!option)continue;const checked=mode===state.permissionMode,button=document.createElement('button');button.type='button';button.className='permission-option';button.dataset.permissionMode=mode;button.role='menuitemradio';button.disabled=option.allowed===false;button.setAttribute('aria-checked',String(checked));const description=option.allowed===false?'Not allowed by managed settings':option.description;button.innerHTML=`<span class="permission-option-icon">${codexIcon(option.icon)}</span><span class="permission-option-copy"><strong>${escapeHtml(option.optionLabel||option.label)}</strong><small>${escapeHtml(description)}</small></span><span class="permission-option-check">${checked?codexIcon('check'):''}</span>`;button.onclick=()=>choosePermissionMode(mode);list.append(button)}}
function syncPermissionSettings(){const autoRow=$('#settingsAutoReviewRow'),autoToggle=$('#settingsAutoReviewToggle'),fullToggle=$('#settingsFullAccessToggle');if(autoRow)autoRow.hidden=true;if(autoToggle)autoToggle.checked=autoReviewSupported();if(fullToggle)fullToggle.checked=state.permissionVisibility.fullAccess;syncTaskNotifySettings()}
const TASK_NOTIFY_STORAGE_KEY='codex-webui-task-notify';
function taskNotifyEnabled(){return localStorage.getItem(TASK_NOTIFY_STORAGE_KEY)!=='false'}
function taskNotificationsSupported(){return typeof globalThis.Notification==='function'}
function syncTaskNotifySettings(){const toggle=$('#settingsTaskNotifyToggle'),supported=taskNotificationsSupported();if(toggle){toggle.disabled=!supported;toggle.checked=supported&&taskNotifyEnabled()&&Notification.permission!=='denied'}}
async function setTaskNotifyEnabled(enabled){if(!taskNotificationsSupported()){syncTaskNotifySettings();return}const on=Boolean(enabled);localStorage.setItem(TASK_NOTIFY_STORAGE_KEY,String(on));if(on&&Notification.permission==='default'){try{await Notification.requestPermission()}catch{}}syncTaskNotifySettings();if(on&&Notification.permission==='denied')toast(t('Browser notifications are blocked'))}
function maybeNotifyTaskCompleted(p){if(!taskNotificationsSupported()||!taskNotifyEnabled()||Notification.permission!=='granted')return;if(document.hasFocus()&&!document.hidden)return;const thread=state.threads.find(x=>x.id===p.threadId),title=thread?.name||t('Task completed');try{new Notification(t('Task completed'),{body:title,tag:`codex-turn-${p.turn?.id||Date.now()}`})}catch{}}
async function requestTaskNotifyPermission(){if(taskNotificationsSupported()&&taskNotifyEnabled()&&Notification.permission==='default'){try{await Notification.requestPermission()}catch{}}}
function syncPermissionControl(){normalizePermissionMode();const selected=selectedPermission();$('#modeButton .control-label').textContent=t(state.planMode?'Plan mode':selected.label);$('#modeButton').classList.toggle('active',state.planMode||state.permissionMode!=='default');if($('#settingsPermissionValue'))$('#settingsPermissionValue').textContent=t(selected.label);syncPermissionSettings();renderPermissionMenu()}
function setPermissionMode(mode){if(!permissionModeAvailable(mode))return;const selected=permissionModeDefinition(mode);state.permissionMode=mode;localStorage.setItem('codex-webui-permission-mode',mode);syncPermissionControl();closePermissionMenu();toast(selected.label)}
function setPermissionVisibility(kind,enabled){state.permissionVisibility[kind]=Boolean(enabled);localStorage.setItem(kind==='autoReview'?'codex-webui-permission-auto-review':'codex-webui-permission-full-access',String(Boolean(enabled)));normalizePermissionMode();syncPermissionControl()}
function openPermissionMenu(){closeModelMenu();syncPermissionControl();$('#permissionMenu').hidden=false;$('#modeButton').setAttribute('aria-expanded','true')}
function closePermissionMenu(){const menu=$('#permissionMenu');menu.hidden=true;$('#modeButton').setAttribute('aria-expanded','false')}
function togglePermissionMenu(){if($('#permissionMenu').hidden)openPermissionMenu();else closePermissionMenu()}
function choosePermissionMode(mode){closePermissionMenu();if(mode==='full-access'&&state.permissionMode!=='full-access'){pendingFullAccessAction='select';const dialog=$('#fullAccessDialog');if(!dialog.open)dialog.showModal();return}setPermissionMode(mode)}
async function loadFolders(path=folderBrowse.path){const list=$('#folderList');list.innerHTML='<div class="list-state">Loading folders…</div>';try{const response=await fetch(`/api/folders?path=${encodeURIComponent(path)}`),data=await response.json();if(!response.ok)throw new Error(data.error||'Cannot browse folder');folderBrowse={path:data.path,parent:data.parent,selected:data.path};$('#folderPathInput').value=data.path;$('#folderSelection').textContent=data.path;$('#folderConfirm').disabled=false;$('#folderUp').disabled=!data.parent;list.innerHTML='';for(const folder of data.folders){const b=document.createElement('button');b.type='button';b.className='folder-item';b.innerHTML=`${icons.file}<span>${escapeHtml(folder.name)}</span>`;b.ondblclick=()=>loadFolders(folder.path);b.onclick=()=>{folderBrowse.selected=folder.path;$('#folderSelection').textContent=folder.path;$('#folderConfirm').disabled=false;list.querySelectorAll('.folder-item').forEach(x=>x.classList.remove('selected'));b.classList.add('selected')};list.append(b)}if(!data.folders.length)list.innerHTML='<div class="list-state">No subfolders</div>'}catch(e){list.innerHTML=`<div class="list-state">${escapeHtml(e.message)}</div>`}}
function openFolderPicker(){const dialog=$('#folderDialog');folderBrowse.selected=null;if(!dialog.open)dialog.showModal();loadFolders(currentComposerCwd()||state.config.defaultCwd||state.config.home);$('#projectlessOption').classList.toggle('selected',state.workspaceSelected&&state.projectless)}
async function syncWorkspaceContext(path){const requestId=workspaceContextRequestGate.next();try{const response=await fetch(`/api/workspace/context?cwd=${encodeURIComponent(path)}`,{cache:'no-store'}),context=await response.json();if(!response.ok)throw new Error(context.error||'Workspace context unavailable');if(!workspaceContextRequestGate.isCurrent(requestId)||state.projectless||!state.workspaceSelected)return;state.workspaceContext=context;if(!state.active&&$('#emptyState'))showEmpty()}catch{if(workspaceContextRequestGate.isCurrent(requestId)&&!state.projectless&&state.workspaceSelected){state.workspaceContext={cwd:path,project:path.split('/').filter(Boolean).at(-1)||path,environment:'Local',branch:'No branch'};if(!state.active&&$('#emptyState'))showEmpty()}}}
function syncProjectControl(){const button=$('#composerProjectButton'),label=$('#composerProjectLabel');button.hidden=Boolean(state.active);label.textContent=t(!state.workspaceSelected?'Choose project':state.projectless?'Tasks':($('#projectName').textContent||'Project'))}
function refreshComposerPlaceholder(){const followUpType=state.active?(state.active.source==='cloud'?'cloud':'local'):undefined;$('#prompt').placeholder=resolveComposerPlaceholder({followUpType,composerMode:state.composerMode,cloudStartingState:state.cloudStartingState,isBackgroundSubagentsPanelVisible:state.backgroundAgentsVisible,isGoalModeActive:state.goalMode,isPlanModeActive:state.planMode,placeholderText:state.placeholderText,isHome:!state.active})}
function setWorkspace(path){const name=path.split('/').filter(Boolean).at(-1)||path,resolved=path.replace(/^~/,state.config.home);workspaceContextRequestGate.next();state.projectless=false;state.workspaceSelected=true;state.workspaceContext={cwd:resolved,project:name,environment:'Local',branch:null};$('#projectPath').textContent=shortPath(path);$('#projectName').textContent=name;rememberDraftWorkspace();syncProjectControl();if(!state.active)showEmpty();if(!$('#summaryPanel').hidden)syncSummaryPanel();syncWorkspaceContext(resolved);if(state.connected)loadPermissionProfiles()}
function setProjectless(){workspaceContextRequestGate.next();state.projectless=true;state.workspaceSelected=true;state.workspaceContext=null;$('#projectPath').textContent='~';$('#projectName').textContent=t('Tasks');rememberDraftWorkspace();syncProjectControl();if(!state.active){$('#threadPath').textContent='';showEmpty()}if(!$('#summaryPanel').hidden)syncSummaryPanel();if(state.connected)loadPermissionProfiles()}
function resetReviewState(){state.turnDiffs.clear();state.activeReview=null;reviewPatchState='undo';$('#reviewTab').hidden=true;if(!$('#reviewPanelContent').hidden)setSidePanelView('launcher','New tab');renderChanges()}
function clearConversationRuntime(){for(const card of state.requestCards.values())card.remove();state.requestCards.clear();for(const animation of state.motion.values())animation?.destroy?.();state.items.clear();state.turns.clear();state.activities.clear();state.activityItems.clear();state.sideTasks.clear();state.dividers.clear();state.motion.clear();renderSideTasks()}
function threadRouteId(){return new URLSearchParams(location.search).get('thread')||null}
function rememberActiveThread(id,{replace=false}={}){
  const url=new URL(location.href);url.pathname='/';url.hash='';
  if(id)url.searchParams.set('thread',id);else url.searchParams.delete('thread');
  const route=url.pathname+url.search;
  if(route!==location.pathname+location.search+location.hash)history[replace?'replaceState':'pushState']({},'',route);
}
function rememberDraftWorkspace(){if(state.active||threadRouteId())return;history.replaceState({...history.state,codexWebuiDraftWorkspace:state.workspaceSelected?{projectless:state.projectless,cwd:state.workspaceContext?.cwd||null}:null},'',location.href)}
function clearWorkspaceSelection(){workspaceContextRequestGate.next();state.workspaceSelected=false;state.projectless=false;state.workspaceContext=null;$('#projectPath').textContent='';$('#projectName').textContent='';$('#threadPath').textContent='';rememberDraftWorkspace();syncProjectControl();if(state.connected)void loadPermissionProfiles()}
function restoreDraftWorkspace(){const draft=history.state?.codexWebuiDraftWorkspace;if(draft?.projectless)setProjectless();else if(typeof draft?.cwd==='string'&&draft.cwd)setWorkspace(draft.cwd);else clearWorkspaceSelection()}
async function restoreLocation(){
  if(state.initializing)return;
  const id=threadRouteId();
  if(id&&state.active?.id!==id)await openThread(id,null,{updateRoute:false});
  else if(!id&&(state.active||state.threadLoading)){const draft=history.state?.codexWebuiDraftWorkspace;startNewTask({updateRoute:false,projectKey:draft?.projectless?'__tasks__':draft?.cwd});}
  if(threadRouteId()!==id)return;
  const currentPage=settingsRoutePage();if(currentPage)showSettings(currentPage,{updateRoute:false});else hideSettings();
}
function startNewTask({projectKey,updateRoute=true,replaceRoute=false}={}){
  threadOpenRequestGate.next();state.threadLoading=false;projectControls?.closeMenu(false);threadControls?.closeMenu(false);
  composerAttachments?.clear();resetActiveThreadSync();setActiveTurnId('');if(updateRoute){hideSettings();rememberActiveThread(null,{replace:replaceRoute})}
  state.active=null;goalControls?.selectThread(null);state.composerMentions=[];state.turnWindow=null;clearConversationRuntime();state.changes.clear();resetReviewState();closeComposerAutocomplete();
  if(projectKey==='__tasks__')setProjectless();else if(projectKey)setWorkspace(projectKey);else clearWorkspaceSelection();
  $('#threadTitle').textContent=t('New task');$('#threadPath').textContent=state.projectless?'':$('#projectPath').textContent;$('#prompt').value='';setPlanMode(false);syncProjectControl();renderContextTray();renderContextUsage();resizePrompt();if(!$('#summaryPanel').hidden)syncSummaryPanel();showEmpty();renderThreads();$('#prompt').focus();
}
function useSelectedFolder(){if(!folderBrowse.selected)return;const path=folderBrowse.selected;$('#folderDialog').close();if(state.active)startNewTask({projectKey:path});else{setWorkspace(path);$('#threadPath').textContent=shortPath(path);renderThreads();$('#prompt').focus()}}
function useProjectless(){$('#folderDialog').close();if(state.active)startNewTask({projectKey:'__tasks__'});else{setProjectless();renderThreads();$('#prompt').focus()}}
function requireWorkspaceSelection(){if(state.active||state.workspaceSelected)return true;toast(t('Choose a project or None before starting a chat'),5200);openFolderPicker();return false}
function titleOf(t){return (t.name||t.preview||'Untitled task').replace(/\s+/g,' ').trim().slice(0,110)}
function shortPath(path=''){const home=state.config.home;return home&&path.startsWith(home)?'~'+path.slice(home.length):path}
function sidebarProjectKey(thread={}){return thread.projectless||!thread.cwd?'__tasks__':String(thread.cwd).replace(/\/+$/,'')||'/'}
function sidebarProjectName(key){if(key==='__tasks__')return'Tasks';if(key===state.config.home)return'Home';return key.split('/').filter(Boolean).at(-1)||key}
function currentSidebarProjectKey(){if(!state.active&&!state.workspaceSelected)return'';if(state.projectless)return'__tasks__';return String(state.active?.cwd||state.workspaceContext?.cwd||$('#projectPath').textContent||'').replace(/^~/,state.config.home).replace(/\/+$/,'')}
function saveSidebarProjectExpansion(){localStorage.setItem(SIDEBAR_PROJECT_EXPANSION_KEY,JSON.stringify(sidebarProjectExpansion))}
function updateThreadMetadata(id,changes){for(const thread of state.threads)if(thread.id===id)Object.assign(thread,changes);if(state.active?.id===id){Object.assign(state.active,changes);if(Object.hasOwn(changes,'name'))renderHeader()}renderThreads();refreshThreadsSoon()}
function removeThreadFromSidebar(id){state.threads=state.threads.filter(thread=>thread.id!==id);if(state.active?.id===id)startNewTask();else renderThreads();refreshThreadsSoon()}
function restoreThreadToProject(thread){state.threads=state.threads.filter(item=>item.id!==thread.id);state.threads.unshift(thread);sidebarProjectExpansion[sidebarProjectKey(thread)]=true;saveSidebarProjectExpansion();renderThreads();refreshThreadsSoon()}
function renderThreads(){
  const list=$('#threadList'),pinnedList=$('#pinnedThreadList'),q=$('#threadSearch').value.trim().toLowerCase(),groups=new Map;
  threadControls?.beforeRender();projectControls?.beforeRender();list.replaceChildren();pinnedList.replaceChildren();
  const matches=thread=>(!q||titleOf(thread).toLowerCase().includes(q)||thread.cwd?.toLowerCase().includes(q));
  const pinned=state.threads.filter(thread=>thread.pinnedAt&&matches(thread)).sort((a,b)=>b.pinnedAt-a.pinnedAt);
  $('#pinnedThreadsSection').hidden=!pinned.length;
  for(const thread of pinned)pinnedList.append(threadControls.createRow(thread));
  for(const thread of state.threads){if(!matches(thread))continue;const key=sidebarProjectKey(thread),group=groups.get(key)||{key,threads:[],recency:0};if(!thread.pinnedAt)group.threads.push(thread);group.recency=Math.max(group.recency,Number(thread.recencyAt||thread.updatedAt)||0);groups.set(key,group)}
  if(!q&&!state.active&&state.workspaceSelected){const key=currentSidebarProjectKey();if(key&&!groups.has(key))groups.set(key,{key,threads:[],recency:0})}
  const currentKey=currentSidebarProjectKey(),ordered=[...groups.values()].sort((a,b)=>(a.key===currentKey?-1:b.key===currentKey?1:b.recency-a.recency));
  for(const group of ordered){
    const containsActive=group.threads.some(thread=>thread.id===state.active?.id),expanded=Boolean(q)||(Object.hasOwn(sidebarProjectExpansion,group.key)?sidebarProjectExpansion[group.key]:containsActive||group.key===currentKey),section=document.createElement('section');section.className='sidebar-project-group';section.dataset.project=group.key;
    const heading=document.createElement('button');heading.type='button';heading.className='sidebar-project-row';heading.setAttribute('aria-expanded',String(expanded));heading.title=group.key==='__tasks__'?t('Tasks'):shortPath(group.key);heading.innerHTML=`${codexIcon(group.key==='__tasks__'?'messageSquare':'folderOpen')}<span data-i18n-ignore>${escapeHtml(sidebarProjectName(group.key))}</span>${codexIcon('chevronRight','sidebar-project-chevron')}`;const toolbar=document.createElement('div');toolbar.className='sidebar-project-toolbar';toolbar.append(heading,projectControls.createActions(group.key));section.append(toolbar);
    const threads=document.createElement('div');threads.className='sidebar-project-threads'+(expanded?' expanded':'');threads.setAttribute('aria-hidden',String(!expanded));threads.style.setProperty('--sidebar-thread-count',String(group.threads.length));
    heading.onclick=()=>{const next=heading.getAttribute('aria-expanded')!=='true';sidebarProjectExpansion[group.key]=next;saveSidebarProjectExpansion();heading.setAttribute('aria-expanded',String(next));threads.setAttribute('aria-hidden',String(!next));threads.classList.toggle('expanded',next)};
    for(const thread of group.threads)threads.append(threadControls.createRow(thread));section.append(threads);list.append(section);
  }
  if(!list.children.length&&!pinned.length){const empty=document.createElement('div');empty.className='list-state';empty.textContent=t('No matching tasks');list.append(empty)}
  threadControls?.afterRender();projectControls?.afterRender();
}
async function openThread(id,fallbackSummary=null,{updateRoute=true}={}){
  const request=threadOpenRequestGate.next();state.threadLoading=true;
  projectControls?.closeMenu(false);
  if(state.active?.id!==id)composerAttachments?.clear();
  const listedSummary=state.threads.find(x=>x.id===id),summary=listedSummary||fallbackSummary,deferTransition=Boolean(fallbackSummary&&!listedSummary);
  if(!deferTransition){
    resetActiveThreadSync();setActiveTurnId('');if(updateRoute)rememberActiveThread(id);
    state.active=summary||{id,turns:[]};goalControls?.selectThread(id);state.composerMentions=[];state.turnWindow=null;clearConversationRuntime();state.changes.clear();resetReviewState();closeComposerAutocomplete();renderContextTray();renderContextUsage();
    if(summary)renderHeader();else{$('#threadTitle').textContent=t('Loading conversation…');syncProjectControl()}
    renderThreads();if(state.initializing)showEmpty();else $('#conversation').innerHTML='<div class="list-state conversation-loading">Loading conversation…</div>';
  }
  syncComposerSubmitState();
  try{
    const result=await rpc('thread/read',{threadId:id,includeTurns:true});
    if(!threadOpenRequestGate.isCurrent(request))return false;
    if(!result.thread?.id)throw new Error(t('This task could not be found. Refresh the task list and try again.'));
    const thread={...(summary||{}),...result.thread};resetActiveThreadSync();setActiveTurnId('');state.active=thread;goalControls?.selectThread(thread.id);if(updateRoute)rememberActiveThread(thread.id);state.composerMentions=[];state.turnWindow=null;clearConversationRuntime();state.changes.clear();resetReviewState();closeComposerAutocomplete();renderContextTray();renderContextUsage();renderHeader();renderThreads();$('#conversation').innerHTML='';
    if((thread.turns||[]).length)renderThread(thread);else $('#conversation').innerHTML='<div class="list-state conversation-loading">No conversation history loaded. Send a message to continue.</div>';
    renderPendingSteers();renderPendingApprovals();scrollOpenedThreadToBottom();scheduleActiveThreadSync(0);return true;
  }catch(error){
    if(!threadOpenRequestGate.isCurrent(request))return false;
    if(deferTransition){toast(error?.message||'Could not load side task');return false}
    if(!summary){startNewTask({replaceRoute:true});toast(error?.message||t('Could not open chat'));return false}
    $('#conversation').innerHTML='<div class="list-state conversation-loading">Could not load history. Send a message to start fresh.</div>';return false;
  }finally{if(threadOpenRequestGate.isCurrent(request)){state.threadLoading=false;syncComposerSubmitState()}}
}

function renderHeader(){const t=state.active;if(!t)return;goalControls?.selectThread(t.id);$('#threadTitle').textContent=titleOf(t);if(t.projectless){state.projectless=true;state.workspaceSelected=true;state.workspaceContext=null;$('#projectName').textContent='Tasks';$('#projectPath').textContent='~';$('#threadPath').textContent=''}else{$('#threadPath').textContent=shortPath(t.cwd);setWorkspace(t.cwd||state.config.home)}syncProjectControl();refreshComposerPlaceholder();$('#threadSource').textContent=t.source||'local'}
function renderThread(thread,loadMore=0){const root=$('#conversation'),turns=thread.turns||[];state.turnWindow=createTurnWindow(turns,DEFAULT_TURN_PAGE_SIZE,state.turnWindow?.threadId===thread.id?state.turnWindow.start:undefined,loadMore);state.turnWindow.threadId=thread.id;clearConversationRuntime();root.innerHTML='';if(state.turnWindow.hiddenCount){const more=document.createElement('button');more.className='load-older';more.textContent=`Load earlier messages (${state.turnWindow.hiddenCount})`;more.onclick=()=>renderThread(thread,DEFAULT_TURN_PAGE_SIZE);root.append(more)}for(const turn of state.turnWindow.visible)renderTurn(turn,root);renderPendingSteers();renderPendingApprovals();if(!root.children.length)showEmpty();else if(!loadMore)scrollBottom()}
function showEmpty(){const root=$('#conversation'),project=state.projectless||!state.workspaceSelected?null:(state.workspaceContext?.project||$('#projectName').textContent?.trim()),loading=state.initializing;root.innerHTML=`<div class="empty-state${loading?' connecting':''}" id="emptyState"${loading?' role="status" aria-label="Connecting to Codex" aria-busy="true"':''}>${codexInterfaceMark('empty-codex-mark')}${loading?'':`<h1>${project?`What can I help with in ${escapeHtml(project)}?`:'What can I help?'}</h1>`}</div>`}
function ensureTurnTimeline(turnId,root=$('#conversation')){let turn=state.turns.get(turnId);if(turn?.isConnected)return turn;root.querySelector('#emptyState')?.remove();turn=document.createElement('article');turn.className='turn assistant-turn native-turn-timeline';turn.dataset.turnId=turnId;turn.dataset.threadId=state.active?.id||'';turn.innerHTML='<div class="assistant-body"><div class="turn-event-stream"></div></div><div class="turn-final-slot"></div>';const footer=initializeTurnPresentation(turn);footer.querySelector('[data-copy-reply]').onclick=()=>void copyTurnReply(turn);footer.querySelector('[data-fork-reply]').onclick=()=>void forkTurnReply(turn);root.append(turn);state.turns.set(turnId,turn);state.dividers.set(turnId,footer);return turn}
function syncWorkedForDivider(turnId,metadata={},options={}){
  const turn=state.turns.get(turnId);if(!turn)return;
  const items=state.activityItems.get(turnId),hasActiveActivity=[...(items?.values()||[])].some(item=>summarizeActivity(item).active);
  updateTurnPresentation(turn,metadata,{...options,hasActiveActivity});
  const settled=[];
  for(const[id,item]of items||[]){const next=settleActivityItem(item,turn.dataset.turnStatus);if(next!==item){items.set(id,next);settled.push([id,next])}}
  // Update the entire cache before rendering: summaries and late snapshots must
  // see the terminal state for every item, including tools absent from the event.
  for(const[id,item]of settled){const group=turn.querySelector(`[data-item-id="${CSS.escape(id)}"]`)?.closest('[data-agent-activity-group]');if(group)addActivity(item,group,id)}
}
function renderTurn(turn,root=$('#conversation'),live=false){
  const turnItems=turn.items||[];
  for(const [index,item] of turnItems.entries()){
    const previous=state.activityItems.get(turn.id)?.get(String(item.id));
    const completed=item.completedAtMs!=null||index<turnItems.length-1||previous?.status==='completed';
    const status=item.status||(completed?'completed':turn.status==='inProgress'?previous?.status||'inProgress':turn.status||'completed');
    upsertItem(item.type==='contextCompaction'?{...item,status}:item,turn.id,root,false);
  }
  if(state.turns.has(turn.id)||turn.status==='inProgress'||turn.error||turn.failure){
    const timeline=ensureTurnTimeline(turn.id,root),nodes=(turn.items||[]).map(item=>state.items.get(item.id)||timeline.querySelector(`[data-item-id="${CSS.escape(activityItemId(item))}"]`)).filter(Boolean);
    orderTimeline(timeline.querySelector('.turn-event-stream'),nodes,{createGroup:(id,single)=>createActivityGroup(id,single),updateGroup:updateActivitySummary,standalone:row=>['reasoning','imageView','contextCompaction'].includes(state.activityItems.get(turn.id)?.get(row.dataset.itemId)?.type)});
    syncWorkedForDivider(turn.id,{...turn,status:turn.status||'completed'},{live});
    if(['completed','interrupted','failed','cancelled','canceled'].includes(timeline.dataset.turnStatus)){
      for(const entry of pendingSteers.list(state.active?.id,turn.id)){if(entry.status!=='sending'){pendingSteers.update(entry.clientId,'notDelivered');renderSteeringDelivery(entry)}}
      steeringInterrupts.get(`${state.active?.id}:${turn.id}`)?.complete(turn);
    }
  }
  const compact=[...(state.activityItems.get(turn.id)?.values()||[])].find(item=>item.type==='contextCompaction'&&summarizeActivity(item).active);
  if(compact&&turn.status==='inProgress')compactionRequests.set(state.active?.id,{turnId:turn.id});
  else if(compactionRequests.get(state.active?.id)?.turnId===turn.id&&(turn.status!=='inProgress'||turnItems.some(item=>item.type==='contextCompaction')))compactionRequests.delete(state.active?.id);
  renderCompactionPending();
}
function showConversationError(error,{turnId=activeTurnId(),terminal=false,willRetry=false}={}){const id=turnId||`request-error-${Date.now()}-${state.rpcId}`,turn=ensureTurnTimeline(id);showTurnError(turn,error,{willRetry});syncWorkedForDivider(id,terminal?{status:'failed'}:{},{live:true});if(terminal&&activeTurnId()===id)setActiveTurnId('');scrollBottom()}
async function copyTurnReply(timeline){
  try{await copyReplyText(replyText(timeline));toast(t('Reply copied'))}
  catch(error){toast(t(error.message||'Could not copy reply'))}
}
async function forkTurnReply(timeline){
  const threadId=timeline.dataset.threadId,turnId=timeline.dataset.turnId,key=`${threadId}:${turnId}`,generation=activeThreadSyncGeneration;
  if(!threadId||timeline.dataset.turnStatus!=='completed'||forkRequests.has(key))return;
  const button=timeline.querySelector('[data-fork-reply]');forkRequests.add(key);button.disabled=true;button.setAttribute('aria-busy','true');
  try{
    const result=await rpc('thread/fork',{threadId,lastTurnId:turnId,deferGoalContinuation:true}),fork=result?.thread;
    if(!fork?.id||fork.id===threadId)throw new Error('Could not create branch');
    if(!state.threads.some(thread=>thread.id===fork.id))state.threads.unshift(fork);
    renderThreads();refreshThreadsSoon();
    if(state.active?.id===threadId&&generation===activeThreadSyncGeneration)await openThread(fork.id,fork);
    toast(t(result.namingError||'Branch created'));
  }catch(error){if(!error?.silentTransportSwitch){toast(error.message||t('Could not create branch'));if(state.active?.id===threadId)showConversationError(error,{turnId:`fork-error-${Date.now()}`,terminal:true})}}
  finally{forkRequests.delete(key);button.disabled=false;button.removeAttribute('aria-busy')}
}
function renderCompactionPending(){
  const root=$('#conversation'),entry=compactionRequests.get(state.active?.id),existing=root.querySelector('[data-compaction-pending]');
  if(!entry||entry.turnId&&state.turns.get(entry.turnId)?.isConnected){existing?.remove();syncComposerSubmitState();return}
  if(!existing){const notice=document.createElement('div');notice.className='compaction-pending loading-shimmer';notice.dataset.compactionPending='';notice.setAttribute('role','status');notice.textContent=t('Compacting context…');root.append(notice)}
  syncComposerSubmitState();
}
function trackCompactionNotification(method,p){
  const threadId=p.threadId,entry=compactionRequests.get(threadId);
  if(!threadId||!entry&&p.item?.type!=='contextCompaction')return;
  if(method==='turn/started'&&entry&&!entry.turnId)entry.turnId=p.turn?.id;
  if(method==='item/started'&&p.item?.type==='contextCompaction')compactionRequests.set(threadId,{turnId:p.turnId});
  if(method==='item/completed'&&p.item?.type==='contextCompaction'||method==='turn/completed'&&entry?.turnId===p.turn?.id||method==='error'&&!p.willRetry&&entry&&(!p.turnId||entry.turnId===p.turnId))compactionRequests.delete(threadId);
  if(threadId===state.active?.id)renderCompactionPending();
}
async function compactActiveThread(){
  const thread=state.active,input=$('#prompt'),draft=input.value,generation=activeThreadSyncGeneration;
  if(!thread?.id){toast(t('Open a task before compacting'));return}
  const threadId=thread.id;
  if(compactionRequests.has(threadId)){toast(t('Context compaction is already in progress'));return}
  if(activeTurnId()||thread.status?.type==='active'){toast(t('Wait for the current task to finish before compacting'));return}
  const pending={turnId:null,requested:false,uncertainAt:0};compactionRequests.set(threadId,pending);renderCompactionPending();scrollBottom();
  try{
    if(thread.canAcceptDirectInput!==true)await resumeActiveThread(threadId);
    const latest=await latestThreadTurn(threadId);
    if(state.active?.id!==threadId||generation!==activeThreadSyncGeneration)throw new Error('Task changed. Try again in the selected task.');
    if(latest?.status==='inProgress')throw new Error('Wait for the current task to finish before compacting');
    pending.requested=true;
    await rpc('thread/compact/start',{threadId});
    if(state.active?.id===threadId&&input.value===draft){input.value='';resizePrompt()}
    scheduleActiveThreadSync(0);
  }catch(error){
    if(error?.silentTransportSwitch){
      if(compactionRequests.get(threadId)===pending){if(pending.requested)pending.uncertainAt=Date.now();else{compactionRequests.delete(threadId);renderCompactionPending()}}
      scheduleActiveThreadSync(0);return;
    }
    compactionRequests.delete(threadId);renderCompactionPending();
    toast(t(error.message||'Context compaction failed'));
    if(state.active?.id===threadId)showConversationError({...error,message:t(error.message||'Context compaction failed')},{turnId:`compact-error-${Date.now()}`,terminal:true});
  }
}
function reconcileCompactionRequest(threadId,turn){
  const entry=compactionRequests.get(threadId);
  if(!entry?.uncertainAt||turn?.status==='inProgress'||Date.now()-entry.uncertainAt<10000)return;
  compactionRequests.delete(threadId);renderCompactionPending();
  showConversationError({message:t('Could not confirm context compaction. Try /compact again.')},{turnId:`compact-error-${Date.now()}`,terminal:true});
}
function textFromInput(content=[]){return content.filter(x=>x.type==='text').map(x=>x.text).join('\n')}
function claimOptimisticUser(item,root,turnId){
  if(String(item.id).startsWith('local-'))return null;
  const candidates=[...root.querySelectorAll('.user-turn')],text=textFromInput(item.content);
  const exact=item.clientId&&candidates.find(node=>node.dataset.clientUserMessageId===item.clientId);
  const host=String(item.id).startsWith('host-user-'),sameText=node=>node.dataset.rawUserText===text;
  const el=exact||candidates.find(node=>node.dataset.optimisticUser==='true'&&(!node.dataset.nativeTurnId||node.dataset.nativeTurnId===turnId)&&sameText(node))||candidates.find(node=>{
    if(node.dataset.nativeTurnId!==turnId||!sameText(node)||host&&node.dataset.initialUser==='true')return false;
    const ids=[...state.items].filter(([,value])=>value===node).map(([id])=>String(id));
    return ids.some(id=>id.startsWith('host-user-')!==host)&&!ids.some(id=>!id.startsWith('local-')&&id.startsWith('host-user-')===host);
  });
  if(!el)return null;
  for(const[id,node]of state.items)if(node===el&&String(id).startsWith('local-'))state.items.delete(id);
  delete el.dataset.optimisticUser;state.items.set(item.id,el);return el;
}
function agentMessageIdFamily(id){const value=String(id||'');return /^item[-_]/.test(value)?'app':/^(?:msg_|host-message-)/.test(value)?'rollout':''}
function claimEquivalentAgentMessage(item,turnId){const family=agentMessageIdFamily(item.id);if(!family)return null;const text=agentMessageText(item,''),commentary=item.phase==='commentary';for(const node of new Set(state.items.values())){const aliases=[...state.items].filter(([,value])=>value===node).map(([id])=>agentMessageIdFamily(id));if(aliases.includes(family)||node.closest('[data-turn-id]')?.dataset.turnId!==turnId)continue;const body=node.querySelector('.message-text'),existingCommentary=node.dataset.localConversationCommentary!==undefined;if(existingCommentary===commentary&&body?.dataset.raw===text){state.items.set(item.id,node);return node}}return null}
function placeAgentMessage(el,item,timeline){const commentary=item.phase==='commentary',slot=timeline.querySelector('.turn-event-stream');el.className=commentary?'assistant-response assistant-commentary':'assistant-response';if(commentary){delete el.dataset.localConversationFinalAssistant;el.dataset.localConversationCommentary=''}else{delete el.dataset.localConversationCommentary;el.dataset.localConversationFinalAssistant=''}if(el.parentElement!==slot)slot.append(el)}
function imageCwd(item={}){return item.cwd||state.active?.cwd||state.config.defaultCwd||'.'}
function sideTaskStatus(item,threadId){const agent=item.agentsStates?.[threadId];if(agent?.status)return agent.status;if(item.type==='subAgentActivity')return item.kind==='interrupted'?'interrupted':'running';return item.status==='failed'?'errored':item.status==='completed'?'completed':'running'}
function updateSideTasks(item){if(item.type==='collabAgentToolCall'){for(const threadId of item.receiverThreadIds||[]){const previous=state.sideTasks.get(threadId)||{};state.sideTasks.set(threadId,{...previous,threadId,prompt:item.prompt||previous.prompt||'',model:item.model||previous.model||'',reasoningEffort:item.reasoningEffort||previous.reasoningEffort||'',status:sideTaskStatus(item,threadId),message:item.agentsStates?.[threadId]?.message||previous.message||''})}}else if(item.type==='subAgentActivity'){const previous=state.sideTasks.get(item.agentThreadId)||{};state.sideTasks.set(item.agentThreadId,{...previous,threadId:item.agentThreadId,agentPath:item.agentPath||previous.agentPath||'',status:sideTaskStatus(item,item.agentThreadId)})}renderSideTasks()}
function renderSideTasks(){const list=$('#sideTaskList');if(!list)return;list.innerHTML='';for(const task of state.sideTasks.values()){const button=document.createElement('button');button.type='button';button.className='side-task-card';button.dataset.threadId=task.threadId;button.innerHTML=`${codexIcon('messageSquare')}<span class="side-task-copy"><strong>${escapeHtml(task.agentPath||task.model||'Side task')}</strong><small>${escapeHtml(task.message||task.prompt||task.threadId)}</small></span><span class="side-task-status ${escapeHtml(task.status||'running')}">${escapeHtml(task.status||'running')}</span>`;button.onclick=async()=>{button.disabled=true;button.setAttribute('aria-busy','true');await openThread(task.threadId,{id:task.threadId,name:task.agentPath||task.model||'Side task',preview:task.prompt||task.message||'',cwd:state.active?.cwd||state.config.defaultCwd,source:'local',sideTask:true});if(button.isConnected){button.disabled=false;button.removeAttribute('aria-busy')}};list.append(button)}if(!state.sideTasks.size)list.innerHTML='<div class="side-task-empty">Side tasks started by this chat will appear here.</div>';const summary=$('#summarySideTasks');if(summary)summary.textContent=state.sideTasks.size?`${state.sideTasks.size} side task${state.sideTasks.size===1?'':'s'}`:'No side tasks'}
function upsertItem(item,turnId,root=$('#conversation'),live=true){
  root.querySelector('#emptyState')?.remove();
  let el=state.items.get(item.id);if(!el&&item.type==='userMessage')el=claimOptimisticUser(item,root,turnId);if(!el&&item.type==='agentMessage')el=claimEquivalentAgentMessage(item,turnId);if(!el){
    if(item.type==='userMessage'){el=document.createElement('article');el.className='turn user-turn';if(String(item.id).startsWith('local-'))el.dataset.optimisticUser='true';el.innerHTML='<div class="user-message"></div>';root.append(el)}
    else if(item.type==='agentMessage'){const timeline=ensureTurnTimeline(turnId,root);el=document.createElement('div');el.innerHTML='<div class="message-text"></div>';placeAgentMessage(el,item,timeline)}
    else if(item.type==='imageGeneration'){const timeline=ensureTurnTimeline(turnId,root);el=document.createElement('div');el.className='assistant-generated-image';timeline.querySelector('.turn-event-stream').append(el)}
    else if(['commandExecution','fileChange','mcpToolCall','dynamicToolCall','collabAgentToolCall','subAgentActivity','webSearch','reasoning','plan','imageView','contextCompaction'].includes(item.type)){const id=activityItemId(item);el=ensureActivity(turnId,root,id,['imageView','reasoning','contextCompaction'].includes(item.type));addActivity(item,el,id)}
    else return;
    if(item.type==='userMessage'||item.type==='agentMessage'||item.type==='imageGeneration')state.items.set(item.id,el);
  }
  if(item.type==='userMessage'){
    if(item.clientId)el.dataset.clientUserMessageId=item.clientId;
    if(turnId!=='optimistic'){
      el.dataset.nativeTurnId=turnId;
      const stream=ensureTurnTimeline(turnId,root).querySelector('.turn-event-stream');if(el.parentElement!==stream){if(!stream.children.length)el.dataset.initialUser='true';stream.append(el)}
    }
    el.dataset.rawUserText=textFromInput(item.content);
    const message=userMessageContent(item),bubble=el.querySelector('.user-message');bubble.replaceChildren();bubble.hidden=!message.text;const text=document.createElement('div');text.className='user-message-text';text.textContent=message.text;bubble.append(text);el.querySelector('.user-attachments')?.remove();const attachments=renderUserAttachments(message.attachments,{cwd:imageCwd(item),translate:t});if(attachments){const template=document.createElement('template');template.innerHTML=attachments;el.insertBefore(template.content,bubble)}
    if(!String(item.id).startsWith('local-')){
      const entry=pendingSteers.commit(item,state.active?.id,turnId);
      if(entry){el.dataset.clientUserMessageId=entry.clientId;renderSteeringDelivery({...entry,status:'received'},el)}
    }
  }
  if(item.type==='agentMessage'){const timeline=ensureTurnTimeline(turnId,root),body=el.querySelector('.message-text'),text=agentMessageText(item,body.dataset.raw??''),cwd=imageCwd(item);placeAgentMessage(el,item,timeline);body.dataset.raw=text;body.innerHTML=renderAssistantMarkdown(text,{cwd})+renderItemImages(item,{cwd,className:'message-image-grid structured-message-images',excludeText:text});syncWorkedForDivider(turnId)}
  if(item.type==='imageGeneration'){const html=renderItemImages(item,{cwd:imageCwd(item),className:'generated-image-grid'});el.innerHTML=html||`<div class="generated-image-pending ${item.status==='inProgress'?'loading-shimmer':''}">${item.status==='failed'?'Image generation failed':'Generating image'}</div>`}
  if(item.type==='fileChange'){for(const ch of item.changes||[]){const path=ch.path||ch.filePath||'Changed file';state.changes.set(path,ch)}syncTurnReviewFromItems(turnId);renderChanges()}
  if(item.type==='collabAgentToolCall'||item.type==='subAgentActivity')updateSideTasks(item)
  if(live)scrollBottom();
}
function activityGroupExpansionKey(activity){const threadId=state.active?.id,turnId=activity.closest('[data-turn-id]')?.dataset.turnId,anchor=activity.dataset.activityGroupAnchor;return threadId&&turnId&&anchor?`codex-webui-activity-group:${threadId}:${turnId}:${anchor}`:null}
function savedActivityGroupExpansion(activity){const key=activityGroupExpansionKey(activity),saved=key&&localStorage.getItem(key);return saved==='open'?true:saved==='closed'?false:null}
function setActivityGroupOpen(activity,open,persist=false){const button=activity.querySelector('.activity-summary'),items=activity.querySelector('.activity-items');button.classList.toggle('open',open);items.classList.toggle('open',open);if(persist&&!activity.classList.contains('single')){const key=activityGroupExpansionKey(activity);if(key)localStorage.setItem(key,open?'open':'closed')}}
function createActivityGroup(itemId,standalone=false){const activity=document.createElement('div');activity.className='activity-group active';activity.dataset.agentActivityGroup='';activity.dataset.activityGroupAnchor=String(itemId||'activity');if(standalone)activity.dataset.standalone='true';activity.innerHTML=`<button class="activity-summary open"><span class="activity-summary-icon" aria-hidden="true"></span><span class="activity-summary-copy loading-shimmer">Working</span>${icons.chevron}</button><div class="activity-items open"></div>`;activity.querySelector('.activity-summary').onclick=()=>setActivityGroupOpen(activity,!activity.querySelector('.activity-summary').classList.contains('open'),true);return activity}
function ensureActivity(turnId,root,itemId,standalone=false){const turn=ensureTurnTimeline(turnId,root),stream=turn.querySelector('.turn-event-stream'),existing=itemId?turn.querySelector(`[data-item-id="${CSS.escape(String(itemId))}"]`)?.closest('[data-agent-activity-group]'):null;if(existing)return existing;let activity=standalone?null:state.activities.get(turnId);if(!activity?.isConnected||activity.parentElement!==stream||stream.lastElementChild!==activity||activity.dataset.standalone==='true'){activity=createActivityGroup(itemId,standalone);stream.append(activity);state.activities.set(turnId,activity)}if(!state.activityItems.has(turnId))state.activityItems.set(turnId,new Map);return activity}
function joinActivityText(value){if(typeof value==='string')return value;if(Array.isArray(value))return value.filter(part=>typeof part==='string').join('\n');return''}
function activityOutput(item){if(item.type==='reasoning')return joinActivityText(item.summary)||joinActivityText(item.content);const output=item.aggregatedOutput??item.output?.aggregatedOutput??item.output;if(typeof output==='string')return output;if(Array.isArray(output))return output.join('\n');return joinActivityText(item.content)||(item.result?JSON.stringify(item.result,null,2):'')}
function commandText(item){return item.command||(item.commandActions||[]).map(action=>action?.command).filter(Boolean).join('\n')||''}
function commandExitCode(item){return item.exitCode??item.output?.exitCode}
function commandFooter(item,data){if(data.active)return{label:'',icon:''};if(item.executionStatus==='interrupted'||item.status==='interrupted'||item.status==='cancelled')return{label:'Stopped',icon:''};const exitCode=commandExitCode(item);if(data.tone==='error')return{label:exitCode==null?'Failed':`Exit code ${exitCode}`,icon:''};return{label:'Success',icon:icons.check}}
function renderCommandShell(out,item,data){if(out.dataset.outputKind!=='command'){out.dataset.outputKind='command';out.className='activity-output command-shell-wrap';out.innerHTML='<div class="command-shell"><div class="command-shell-body"><div class="command-shell-command"><span aria-hidden="true">$</span><code></code></div><div class="command-shell-output"><pre></pre></div></div><div class="command-shell-footer"></div></div>'}const output=activityOutput(item),pre=out.querySelector('.command-shell-output pre'),footer=commandFooter(item,data);out.querySelector('.command-shell-command code').textContent=commandText(item);pre.textContent=output||(data.active?'':'No output');pre.classList.toggle('empty',!output);out.querySelector('.command-shell-footer').innerHTML=`${footer.icon}<span>${footer.label}</span>`}
function inlineFileChangeDiff(change){const raw=unifiedDiffFromFileChanges([change]),review=parseUnifiedDiff(raw);if(!review.hasChanges){const diff=change.diff||change.unified_diff||'';return diff?`<pre>${escapeHtml(diff)}</pre>`:''}return `<div class="file-change-inline-diff">${review.files.flatMap(file=>file.hunks.map(hunk=>`<div class="file-change-inline-hunk"><div class="review-hunk-head">${escapeHtml(hunk.header)}</div><div class="review-lines">${hunk.lines.map(reviewLineHtml).join('')}</div></div>`)).join('')}</div>`}
function renderFileChangeOutput(out,item,data){out.dataset.outputKind='file-change';out.className='activity-output file-change-output';const changes=item.changes||[],legacy=activityOutput(item);if(!changes.length){out.innerHTML=`<div class="file-change-progress ${data.active?'loading-shimmer':''}">${escapeHtml(legacy||(data.active?'Waiting for patch details…':'No patch details'))}</div>`;return}out.innerHTML=changes.map(change=>{const path=change.path||change.filePath||'Changed file',kind=typeof change.kind==='string'?change.kind:change.kind?.type||'update';return `<section class="file-change-output-item"><div class="file-change-output-head">${codexIcon('fileDiff')}<span>${escapeHtml(shortPath(path))}</span><small>${escapeHtml(kind)}</small></div>${inlineFileChangeDiff(change)}</section>`}).join('')}
function isExplorationActivity(item,data=summarizeActivity(item)){return item.type==='commandExecution'&&['read','search','list'].includes(data.category)}
function renderActivityOutput(out,item,data){if(item.type==='imageView'){out.dataset.outputKind='image';out.className='activity-output activity-image-output';out.innerHTML=renderItemImages(item,{cwd:imageCwd(item),className:'activity-image-grid'})||'<div class="message-image-unavailable" data-i18n-ui>Image unavailable</div>';return}if(item.type==='commandExecution'&&data.category==='command'){renderCommandShell(out,item,data);return}if(item.type==='fileChange'){renderFileChangeOutput(out,item,data);return}if(item.type==='reasoning'){const text=activityOutput(item);out.dataset.outputKind='reasoning';out.className='activity-output reasoning-output message-text';out.innerHTML=text?renderAssistantMarkdown(text,{cwd:imageCwd(item)}):'';return}out.dataset.outputKind='plain';out.className='activity-output';out.textContent=isExplorationActivity(item,data)?'':activityOutput(item)||''}
function activityItemExpansionKey(row){const threadId=state.active?.id,turnId=row.closest('[data-turn-id]')?.dataset.turnId,itemId=row.dataset.itemId;return threadId&&turnId&&itemId?`codex-webui-activity-item:${threadId}:${turnId}:${itemId}`:null}
function savedActivityItemExpansion(row){const key=activityItemExpansionKey(row),saved=key&&localStorage.getItem(key);return saved==='open'?true:saved==='closed'?false:null}
function setActivityExpanded(row,expanded,persist=false){row.classList.toggle('expanded',expanded);row.setAttribute('aria-expanded',String(expanded));if(persist){const key=activityItemExpansionKey(row);if(key)localStorage.setItem(key,expanded?'open':'closed')}}
function motionIcon(name){return `<span class="activity-motion" data-animation="${name}"></span>`}
async function mountMotion(row,name){const holder=row.querySelector('.activity-motion');if(!holder)return;state.motion.get(row)?.destroy();try{const animationData=await fetch(`/assets/codex-motion/${name}.json`).then(r=>r.json());if(!holder.isConnected)return;const animation=lottie.loadAnimation({container:holder,renderer:'svg',loop:true,autoplay:true,animationData,rendererSettings:{preserveAspectRatio:'xMidYMid meet'}});state.motion.set(row,animation)}catch{holder.innerHTML=codexIcon('loaderCircle','motion-fallback')}}
function activityIconName(item,data=summarizeActivity(item)){if(item.type==='reasoning')return null;if(data.tone==='error')return'triangleAlert';if(item.type==='fileChange')return'fileDiff';if(data.category==='image')return'image';if(data.category==='read')return'file';if(data.category==='search'||item.type==='webSearch')return'search';if(data.category==='list'||data.category==='compaction')return'list';if(data.category==='command')return'terminal';return'wrench'}
function stopMotion(row,tone){const animation=state.motion.get(row);animation?.destroy();state.motion.delete(row);const holder=row.querySelector('.activity-motion'),turnId=row.closest('[data-turn-id]')?.dataset.turnId,item=state.activityItems.get(turnId)?.get(row.dataset.itemId),data=item?summarizeActivity(item):{tone};if(!holder)return;const icon=activityIconName(item||{},data);holder.innerHTML=icon?codexIcon(icon):''}
function activityItemId(item){return String(item.id||item.callId||item.requestId||`${item.type}-${Date.now()}`)}
function joinActivityParts(parts){return parts.length<2?parts[0]||'Worked':`${parts.slice(0,-1).join(', ')} and ${parts.at(-1)}`}
function completedActivitySummary(items){if(items.length===1&&items[0].type==='contextCompaction')return summarizeActivity(items[0]).label;const summaries=items.map(item=>({item,data:summarizeActivity(item)})),commands=summaries.filter(({item,data})=>item.type==='commandExecution'&&data.category==='command').length,explored=summaries.some(({data})=>['read','search','list'].includes(data.category)&&data.tone!=='error'),edits=summaries.filter(({item,data})=>item.type==='fileChange'&&data.tone!=='error').reduce((count,{item})=>count+Math.max(1,item.changes?.length||0),0),web=summaries.some(({item,data})=>item.type==='webSearch'&&data.tone!=='error'),images=summaries.some(({data})=>data.category==='image'&&data.tone!=='error'),failed=summaries.some(({data})=>data.tone==='error'),parts=[],add=(leading,following)=>parts.push(parts.length?following:leading);if(edits)add(edits===1?'Edited a file':'Edited files',edits===1?'edited a file':'edited files');if(explored)add('Read files','read files');if(commands)add(commands===1?'Ran a command':'Ran commands',commands===1?'ran a command':'ran commands');if(web)add('Searched the web','searched the web');if(images)add('Viewed images','viewed images');if(!parts.length&&failed)return'Activity failed';return joinActivityParts(parts)}
function completedActivityPrimaryItem(items){const summaries=items.map(item=>({item,data:summarizeActivity(item)})),find=predicate=>summaries.find(predicate)?.item;return find(({item,data})=>item.type==='fileChange'&&data.tone!=='error')||find(({data})=>['read','search','list'].includes(data.category)&&data.tone!=='error')||find(({data})=>data.category==='command'&&data.tone!=='error')||find(({item,data})=>item.type==='webSearch'&&data.tone!=='error')||find(({data})=>data.category==='image'&&data.tone!=='error')||items.find(item=>summarizeActivity(item).tone==='error')||items[0]}
function setActivitySummaryIcon(activity,item){const holder=activity.querySelector('.activity-summary-icon'),icon=item&&activityIconName(item);if(holder){holder.hidden=!icon;holder.innerHTML=icon?codexIcon(icon):''}}
function commandRowSummary(item,data,expanded){if(data.active)return data.label;const interrupted=item.executionStatus==='interrupted'||item.status==='interrupted'||item.status==='cancelled',command=commandText(item);if(expanded)return interrupted?'Stopped command':'Ran command';return`${interrupted?'Stopped':'Ran'}${command?` ${command}`:' command'}`}
function updateCommandRowSummary(row,item,data,expanded=row.classList.contains('expanded')){const summary=row.querySelector('.activity-name');if(summary)summary.textContent=commandRowSummary(item,data,expanded)}
function updateActivitySummary(activity){const turn=activity.closest('[data-turn-id]'),turnId=turn?.dataset.turnId,allItems=state.activityItems.get(turnId),rows=[...activity.querySelectorAll('.activity-item')],items=rows.map(row=>allItems?.get(row.dataset.itemId)).filter(Boolean),summary=activity.querySelector('.activity-summary-copy');if(!turn||!summary)return;activity.classList.toggle('single',items.length===1);const activeItem=items.findLast?.(item=>summarizeActivity(item).active)||[...items].reverse().find(item=>summarizeActivity(item).active),savedOpen=savedActivityGroupExpansion(activity);if(activeItem){const data=summarizeActivity(activeItem);setActivitySummaryIcon(activity,activeItem);summary.textContent=data.label;summary.classList.add('loading-shimmer');activity.classList.add('active');setActivityGroupOpen(activity,items.length===1||(savedOpen??true))}else{setActivitySummaryIcon(activity,completedActivityPrimaryItem(items));summary.textContent=completedActivitySummary(items);summary.classList.remove('loading-shimmer');activity.classList.remove('active');setActivityGroupOpen(activity,items.length===1||(savedOpen??false))}syncWorkedForDivider(turnId)}
function addActivity(item,activity,id=activityItemId(item)){item=settleActivityItem(item,activity.closest('[data-turn-id]')?.dataset.turnStatus);const data=summarizeActivity(item),turn=activity.closest('[data-turn-id]'),turnId=turn.dataset.turnId,items=state.activityItems.get(turnId)||new Map,box=activity.querySelector('.activity-items');items.set(id,item);state.activityItems.set(turnId,items);let row=box.querySelector(`[data-item-id="${CSS.escape(id)}"]`);if(!row){row=document.createElement('div');row.className='activity-item entering';row.dataset.itemId=id;box.append(row);const out=document.createElement('div');out.className='activity-output';box.append(out)}const imageView=item.type==='imageView',reasoning=item.type==='reasoning',command=item.type==='commandExecution'&&data.category==='command',fileChange=item.type==='fileChange',wasActive=row.dataset.activityWasActive==='true',savedExpanded=savedActivityItemExpansion(row),existingExpanded=row.dataset.expansionInitialized?row.classList.contains('expanded'):imageView,expanded=reasoning?(data.active?true:wasActive?false:(savedExpanded??existingExpanded)):(savedExpanded??existingExpanded);row.dataset.expansionInitialized='true';row.dataset.activityWasActive=String(data.active);row.className=`activity-item ${command?'command-activity ':''}${reasoning?'reasoning-activity ':''}${imageView?'image-activity ':''}${fileChange?'file-change-activity ':''}${data.active?'active':'settled'} ${data.tone}`;if(command){state.motion.get(row)?.destroy();state.motion.delete(row);row.innerHTML=`<span class="activity-command-icon">${icons.terminal}</span><div class="activity-copy"><div class="activity-name ${data.active?'loading-shimmer':''}">${escapeHtml(commandRowSummary(item,data,expanded))}</div></div><span class="activity-command-chevron">${icons.chevron}</span>`}else if(reasoning){state.motion.get(row)?.destroy();state.motion.delete(row);row.innerHTML=`<div class="activity-copy"><div class="activity-name ${data.active?'loading-shimmer':''}">${escapeHtml(data.label)}</div></div><span class="activity-reasoning-chevron">${icons.chevron}</span>`}else{const detail=shortPath(data.detail||'');row.innerHTML=`${motionIcon(data.animation)}<div class="activity-copy"><div class="activity-name ${data.active?'loading-shimmer':''}"><span class="activity-label">${escapeHtml(data.label)}</span>${detail?` <span class="activity-detail">${escapeHtml(detail)}</span>`:''}</div></div><span class="activity-result">${fileChange?icons.chevron:''}</span>`}const out=row.nextElementSibling;renderActivityOutput(out,item,data);const reasoningOutput=reasoning&&!!activityOutput(item),expandable=imageView||command||fileChange||(reasoning&&!data.active&&reasoningOutput)||(!reasoning&&!isExplorationActivity(item,data)&&!!activityOutput(item));if(reasoning&&data.active&&reasoningOutput){row.removeAttribute('role');row.removeAttribute('aria-expanded');row.tabIndex=-1;row.classList.add('expanded')}else if(expandable){row.setAttribute('role','button');row.tabIndex=0;setActivityExpanded(row,expanded)}else{row.removeAttribute('role');row.removeAttribute('aria-expanded');row.tabIndex=-1;row.classList.remove('expanded')}row.onclick=expandable?()=>{const next=!row.classList.contains('expanded');setActivityExpanded(row,next,true);if(command)updateCommandRowSummary(row,item,data,next)}:null;row.onkeydown=expandable?event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();row.click()}}:null;if(!command&&!reasoning){if(data.active)mountMotion(row,data.animation);else stopMotion(row,data.tone)}updateActivitySummary(activity)}
function diffForTurn(turnId){return state.turnDiffs.get(turnId)||null}
function recordTurnReview(turnId,raw,source='fileChange'){if(!turnId||!raw)return null;const existing=state.turnDiffs.get(turnId);if(source!=='native'&&existing?.source==='native')return existing;const review=parseUnifiedDiff(raw);if(!review.hasChanges)return null;review.turnId=turnId;review.raw=raw;review.source=source;state.turnDiffs.set(turnId,review);state.activeReview=review;$('#reviewTab').hidden=false;renderChanges();return review}
function syncTurnReviewFromItems(turnId){const items=state.activityItems.get(turnId),changes=items?[...items.values()].flatMap(item=>item?.type==='fileChange'&&Array.isArray(item.changes)?item.changes:[]):[],raw=unifiedDiffFromFileChanges(changes);if(raw)recordTurnReview(turnId,raw)}
function saveReviewPreferences(){localStorage.setItem('codex-webui-review-preferences',JSON.stringify(reviewPreferences))}
function reviewLineHtml(line){if(!line)return '<div class="review-line empty"><span class="review-sign"></span><code></code></div>';return `<div class="review-line ${line.type}"><span class="review-sign">${line.type==='add'?'+':line.type==='delete'?'−':' '}</span><code>${escapeHtml(line.text)}</code></div>`}
function reviewHunkHtml(hunk){if(reviewPreferences.mode==='split'){return `<div class="review-split-lines">${splitDiffHunk(hunk).map(row=>`<div class="review-split-row"><div class="review-side old">${reviewLineHtml(row.left)}</div><div class="review-side new">${reviewLineHtml(row.right)}</div></div>`).join('')}</div>`}return `<div class="review-lines">${hunk.lines.map(reviewLineHtml).join('')}</div>`}
function syncReviewControls(review){const has=!!review?.hasChanges;$('#reviewMode').disabled=!has;$('#reviewWrap').disabled=!has;$('#reviewExpand').disabled=!has;$('#reviewPatch').disabled=!has||!state.active?.id||!review?.turnId;$('#reviewMode').title=reviewPreferences.mode==='unified'?'Switch to split diff':'Switch to unified diff';$('#reviewWrap').title=reviewPreferences.wrap?'Disable word wrap':'Enable word wrap';$('#reviewExpand').title=reviewPreferences.expanded?'Collapse all diffs':'Expand all diffs';$('#reviewPatch').title=reviewPatchState==='undo'?'Undo changes':'Reapply changes';$('#reviewPatch').innerHTML=codexIcon(reviewPatchState==='undo'?'undo':'redo')}
function renderChanges(){const list=$('#changeList'),review=state.activeReview||[...state.turnDiffs.values()].at(-1)||null,reviewVisible=document.body.classList.contains('side-panel-open')&&!$('#reviewPanelContent').hidden;document.body.classList.toggle('review-split-open',reviewVisible&&reviewPreferences.mode==='split'&&!!review?.hasChanges&&innerWidth>1200);list.dataset.mode=reviewPreferences.mode;list.classList.toggle('wrap',reviewPreferences.wrap);if(review?.hasChanges){$('#changeCount').textContent=review.fileCount;$('#changeSummary').textContent=`${review.fileCount} changed file${review.fileCount===1?'':'s'}`;$('#reviewStats').innerHTML=`<span class="plus">+${review.linesAdded}</span><span class="minus">−${review.linesDeleted}</span>`;list.innerHTML='';for(const file of review.files){const section=document.createElement('section');section.className='review-file';section.dataset.path=file.path;section.innerHTML=`<button class="review-file-head" aria-expanded="${reviewPreferences.expanded}">${codexIcon('chevronDown','review-chevron')}<span class="review-file-name">${escapeHtml(shortPath(file.path))}</span><span class="review-file-stats"><span class="plus">+${file.linesAdded}</span><span class="minus">−${file.linesDeleted}</span></span></button><div class="review-hunks"${reviewPreferences.expanded?'':' hidden'}></div>`;const body=section.querySelector('.review-hunks');for(const hunk of file.hunks){const h=document.createElement('div');h.className='review-hunk';h.innerHTML=`<div class="review-hunk-head">${escapeHtml(hunk.header)}</div>${reviewHunkHtml(hunk)}`;body.append(h)}section.querySelector('.review-file-head').onclick=e=>{const open=e.currentTarget.getAttribute('aria-expanded')==='true';e.currentTarget.setAttribute('aria-expanded',String(!open));body.hidden=open};list.append(section)}syncReviewControls(review);return}$('#reviewStats').textContent='';$('#changeCount').textContent=state.changes.size;$('#changeSummary').textContent=state.changes.size?`${state.changes.size} changed file${state.changes.size===1?'':'s'}`:'No changes yet';list.innerHTML='';for(const [path,ch] of state.changes){const el=document.createElement('div');el.className='change-item';el.innerHTML=`<div class="change-path">${icons.file}<span>${escapeHtml(shortPath(path))}</span></div><div class="change-stats"><span class="plus">+${ch.additions||0}</span> <span class="minus">−${ch.deletions||0}</span></div>`;list.append(el)}if(!state.changes.size)list.innerHTML='<div class="panel-empty">Changes made by Codex will appear here.</div>';syncReviewControls(null)}
async function applyActiveReviewPatch(){const review=state.activeReview;if(!review?.turnId||!state.active?.id)return;const action=reviewPatchState,button=$('#reviewPatch');button.disabled=true;button.innerHTML=codexIcon('loaderCircle','review-loading');try{const response=await fetch('/api/review/patch',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({threadId:state.active.id,turnId:review.turnId,action})}),result=await response.json();if(!response.ok)throw new Error(result.error||'Review patch failed');reviewPatchState=action==='undo'?'reapply':'undo';toast(action==='undo'?'Changes reverted':'Changes reapplied')}catch(error){toast(error.message)}finally{syncReviewControls(review)}}
function applyTerminalInteraction(p){const itemId=String(p.itemId),current=state.activityItems.get(p.turnId)?.get(itemId);if(current?.type!=='commandExecution')return;let buffer=current.terminalInputBuffer||'',commands=[];for(const char of String(p.stdin||'')){if(char==='\r'||char==='\n'){const command=buffer.trim();if(command)commands.push(command);buffer='';continue}if(char==='\u0003'){buffer='';continue}if(char==='\b'||char==='\u007f'){buffer=buffer.slice(0,-1);continue}buffer+=char}const actions=[...(current.commandActions||[]),...commands.map(command=>({type:'unknown',command}))];upsertItem({...current,status:'inProgress',terminalInputBuffer:buffer,commandActions:actions},p.turnId)}

function onNotification(method,p){
  goalControls?.notification(method,p);
  threadControls?.notification(method,p);
  trackCompactionNotification(method,p);
  if(state.serverRequests.handleNotification({method,params:p}))renderPendingApprovals();
  if(p.threadId&&(method==='turn/started'||method==='turn/completed'))updateThreadMetadata(p.threadId,{status:{type:method==='turn/started'?'active':'idle'}});
  if(p.threadId&&p.threadId!==state.active?.id&&(method==='error'||method.startsWith('turn/')||method.startsWith('item/')))return;
  if(method==='account/updated')loadAccount(true);
  else if(method==='thread/started'){const index=state.threads.findIndex(thread=>thread.id===p.thread.id);if(index<0)state.threads.unshift(p.thread);else state.threads[index]={...state.threads[index],...p.thread};renderThreads()}
  else if(method==='thread/name/updated')updateThreadMetadata(p.threadId,{name:p.name});
  else if(method==='host/thread/pinned')updateThreadMetadata(p.threadId,{pinnedAt:p.pinnedAt});
  else if(method==='thread/archived')removeThreadFromSidebar(p.threadId);
  else if(method==='thread/unarchived')refreshThreadsSoon();
  else if(method==='turn/started'){if(p.turn?.id){renderTurn({...p.turn,status:'inProgress'},$('#conversation'),true);syncTurnRuntime({...p.turn,status:'inProgress'});scrollBottom()}scheduleActiveThreadSync(0)}
  else if(method==='item/started')upsertItem({...p.item,status:'inProgress'},p.turnId);
  else if(method==='item/completed'){const status=['failed','declined','interrupted','cancelled','canceled'].includes(p.item?.status)?p.item.status:'completed';upsertItem({...p.item,status},p.turnId)}
  else if(method==='item/agentMessage/delta'){let el=state.items.get(p.itemId);if(!el){upsertItem({id:p.itemId,type:'agentMessage',text:''},p.turnId);el=state.items.get(p.itemId)}const body=el.querySelector('.message-text');body.dataset.raw=(body.dataset.raw||'')+p.delta;body.innerHTML=renderAssistantMarkdown(body.dataset.raw,{cwd:imageCwd()});scrollBottom()}
  else if(method==='item/reasoning/summaryPartAdded')upsertReasoningDelta(p,null);
  else if(method==='item/reasoning/summaryTextDelta')upsertReasoningDelta(p,'summary');
  else if(method==='item/reasoning/textDelta')upsertReasoningDelta(p,'content');
  else if(method==='item/commandExecution/outputDelta'){const turn=state.turns.get(p.turnId),row=turn?.querySelector(`[data-item-id="${CSS.escape(p.itemId)}"]`),item=state.activityItems.get(p.turnId)?.get(String(p.itemId));if(item)item.aggregatedOutput=(item.aggregatedOutput||'')+(p.delta||'');if(row){const target=row.nextElementSibling.querySelector('.command-shell-output pre')||row.nextElementSibling;target.textContent=(target.classList.contains('empty')?'':target.textContent||'')+(p.delta||'');target.classList.remove('empty')}}
  else if(method==='item/commandExecution/terminalInteraction')applyTerminalInteraction(p)
  else if(method==='item/fileChange/outputDelta'){const itemId=String(p.itemId),current=state.activityItems.get(p.turnId)?.get(itemId),item=current?.type==='fileChange'?{...current,status:'inProgress'}:{id:itemId,type:'fileChange',status:'inProgress',changes:[]};item.aggregatedOutput=(item.aggregatedOutput||'')+(p.delta||'');upsertItem(item,p.turnId)}
  else if(method==='item/fileChange/patchUpdated'){const itemId=String(p.itemId),current=state.activityItems.get(p.turnId)?.get(itemId),item=current?.type==='fileChange'?{...current,status:'inProgress',changes:p.changes||[]}:{id:itemId,type:'fileChange',status:'inProgress',changes:p.changes||[]};upsertItem(item,p.turnId)}
  else if(method==='turn/diff/updated'){if(p.threadId&&state.active?.id&&p.threadId!==state.active.id)return;recordTurnReview(p.turnId,p.diff||'','native')}
  else if(method==='turn/completed'){if(!p.turn?.id||activeTurnId()===p.turn.id)setActiveTurnId('');if(p.turn?.id){renderTurn({...p.turn,status:p.turn.status||'completed'},$('#conversation'),true);scrollBottom()}maybeNotifyTaskCompleted(p);scheduleActiveThreadSync(0);refreshThreadsSoon()}
  else if(method==='thread/tokenUsage/updated'){const threadId=p.threadId||state.active?.id;if(threadId&&p.tokenUsage)state.tokenUsage.set(threadId,p.tokenUsage);if(threadId===state.active?.id)renderContextUsage()}
  else if(method==='thread/status/changed'){updateThreadMetadata(p.threadId,{status:p.status});if(p.threadId===state.active?.id)scheduleActiveThreadSync(0)}
  else if(method==='error')showConversationError(p.error||p,{turnId:p.turnId||activeTurnId(),willRetry:p.willRetry===true,terminal:Boolean(p.turnId&&!p.willRetry)});
}
function upsertReasoningDelta(p,field){const itemId=String(p.itemId),items=state.activityItems.get(p.turnId),current=items?.get(itemId),item=current?.type==='reasoning'?{...current,status:'inProgress'}:{id:itemId,type:'reasoning',status:'inProgress',summary:[],content:[]};if(field){const index=field==='summary'?(p.summaryIndex??0):(p.contentIndex??0),parts=Array.isArray(item[field])?[...item[field]]:[];while(parts.length<=index)parts.push('');parts[index]=(parts[index]||'')+(p.delta||'');item[field]=parts}upsertItem(item,p.turnId);scrollBottom()}
function setApprovalWaiting(group,itemId,waiting){if(!group)return;const row=itemId?group.querySelector(`[data-item-id="${CSS.escape(itemId)}"]`):null,summary=group.querySelector('.activity-summary-copy');group.classList.toggle('waiting-approval',waiting);if(waiting){summary.textContent='Waiting for approval';summary.classList.remove('loading-shimmer');if(row){row.querySelector('.activity-name')?.classList.remove('loading-shimmer');state.motion.get(row)?.pause()}}else{if(row){const turnId=group.closest('[data-turn-id]')?.dataset.turnId,active=summarizeActivity(state.activityItems.get(turnId)?.get(String(itemId))||{}).active;row.querySelector('.activity-name')?.classList.toggle('loading-shimmer',active);if(active)state.motion.get(row)?.play();else stopMotion(row)}updateActivitySummary(group)}}
function approvalIcon(kind){return kind==='network'?codexIcon('globe'):kind==='patch'?codexIcon('fileDiff'):kind==='permission'?codexIcon('shield'):codexIcon('terminal')}
function approvalBody(model,p){if(model.kind==='exec'||model.kind==='network')return `<div class="approval-command"><code>${escapeHtml(p.command||model.title)}</code></div>`;if(model.kind==='patch'){const review=diffForTurn(p.turnId);return review?.hasChanges?`<button type="button" class="approval-review-link">${codexIcon('fileDiff')}<span>Review ${review.fileCount} changed file${review.fileCount===1?'':'s'}</span><span class="plus">+${review.linesAdded}</span><span class="minus">−${review.linesDeleted}</span></button>`:''}return permissionRows(p.permissions).map(row=>`<div class="permission-row"><span>${escapeHtml(row.label)}</span><code>${escapeHtml(shortPath(row.value))}</code></div>`).join('')}
function replyUnsupportedRequest(req){void respondToCodex(req.id,null,{code:-32601,message:'Unsupported request'}).catch(error=>{if(!error?.silentTransportSwitch)toast(error.message)})}
function onServerRequests(requests=[]){
  state.serverRequests.replace(requests);
  for(const req of requests)if(!isApprovalRequest(req))replyUnsupportedRequest(req);
  renderPendingApprovals();
}
function onServerRequest(req){
  if(!isApprovalRequest(req)){replyUnsupportedRequest(req);return}
  state.serverRequests.record(req);renderPendingApprovals();
}
function renderPendingApprovals(){
  const requests=state.serverRequests.snapshot(),visible=requests.filter(req=>isApprovalRequest(req)&&req.params?.threadId===state.active?.id),ids=new Set(visible.map(req=>req.id));
  for(const[id,card]of state.requestCards){
    if(ids.has(id)&&card.isConnected)continue;
    const context=approvalContexts.get(card);
    if(context)setApprovalWaiting(context.group,context.itemId,false);
    card.remove();state.requestCards.delete(id);
  }
  for(const req of visible){
    const card=state.requestCards.get(req.id),context=card&&approvalContexts.get(card);
    if(!card)renderApprovalCard(req);
    else if(context)setApprovalWaiting(context.group,context.itemId,true);
  }
}
function closeApprovalMenus(path=[]){
  for(const card of state.requestCards.values()){
    const menu=card.querySelector('.approval-menu'),toggle=card.querySelector('.approval-menu-toggle');
    if(!menu||path.includes(menu)||path.includes(toggle))continue;
    menu.hidden=true;toggle?.setAttribute('aria-expanded','false');
  }
}
function renderApprovalCard(req){const p=req.params||{};const group=ensureActivity(p.turnId||'approval',$('#conversation'),p.itemId),model=buildApprovalModel(req),card=document.createElement('section');card.className='approval-card';card.dataset.codexApprovalSurface='';card.innerHTML=`<div class="approval-content"><div class="approval-identity">${approvalIcon(model.kind)}<span>${escapeHtml(model.identity)}</span></div><div class="approval-title">${escapeHtml(model.title)}</div>${model.subtitle?`<div class="approval-subtitle">${escapeHtml(shortPath(model.subtitle))}</div>`:''}${model.reason?`<div class="approval-reason"><span>Reason</span><p>${escapeHtml(model.reason)}</p></div>`:''}</div><div class="approval-body">${approvalBody(model,p)}</div><form class="approval-actions">${model.leading?`<button type="button" class="approval-leading">${escapeHtml(model.leading.label)}</button>`:''}<div class="approval-actions-main"><button type="button" class="approval-deny">${escapeHtml(model.deny.label)}</button>${model.scoped?`<div class="approval-split"><button type="submit" class="approval-primary" autofocus>${escapeHtml(model.primary.label)}</button><button type="button" class="approval-menu-toggle" aria-label="Approval options" aria-expanded="false">${codexIcon('chevronDown')}</button><div class="approval-menu" hidden><button type="button" class="approval-scoped">${escapeHtml(model.scoped.label)}</button></div></div>`:`<button type="submit" class="approval-primary" autofocus>${escapeHtml(model.primary.label)}</button>`}</div></form>`;group.after(card);state.requestCards.set(req.id,card);approvalContexts.set(card,{group,itemId:p.itemId});setApprovalWaiting(group,p.itemId,true);const answer=async(decision)=>{
  card.querySelectorAll('button').forEach(button=>button.disabled=true);
  try{
    await respondToCodex(req.id,model.kind==='permission'?decision:{decision});
    state.serverRequests.resolve(req.id);renderPendingApprovals();
  }catch(error){
    if(!card.isConnected)return;
    card.querySelectorAll('button').forEach(button=>button.disabled=false);
    if(!error?.silentTransportSwitch){
      let notice=card.querySelector('[data-approval-error]');
      if(!notice){notice=document.createElement('div');notice.className='turn-request-error';notice.dataset.approvalError='';notice.setAttribute('role','alert');card.append(notice)}
      notice.textContent=threadInputErrorMessage(error);
    }
  }
};card.querySelector('form').onsubmit=e=>{e.preventDefault();answer(model.primary.decision)};card.querySelector('.approval-deny').onclick=()=>answer(model.deny.decision);card.querySelector('.approval-scoped')?.addEventListener('click',()=>answer(model.scoped.decision));card.querySelector('.approval-leading')?.addEventListener('click',()=>answer(model.leading.decision));card.querySelector('.approval-review-link')?.addEventListener('click',()=>openReviewPanel(diffForTurn(p.turnId)));const menuToggle=card.querySelector('.approval-menu-toggle'),menu=card.querySelector('.approval-menu');menuToggle?.addEventListener('click',()=>{const open=menu.hidden;menu.hidden=!open;menuToggle.setAttribute('aria-expanded',String(open))});scrollBottom()}
const slashCommandCatalog=[
  {id:'model',title:'Model',description:'Choose model and reasoning effort',icon:'wrench'},
  {id:'goal',title:'Goal',description:'Set and manage a persistent goal',icon:'check'},
  {id:'plan',title:'Plan mode',description:'Turn plan mode on',icon:'list'},
  {id:'project',title:'Project',description:'Choose project for new tasks',icon:'folderOpen'},
  {id:'reasoning',title:'Reasoning',description:'Choose reasoning effort',icon:'wrench'},
  {id:'init',title:'Init',description:'Create an AGENTS.md file with instructions for Codex',icon:'file'},
  {id:'mcp',title:'MCP',description:'Show MCP server status',icon:'wrench'},
  {id:'compact',title:'Compact',description:"Compact this task's context",icon:'list',requiresThread:true},
  {id:'status',title:'Status',description:'Show task id, context usage, and rate limits',icon:'info',requiresThread:true},
];
function closeComposerAutocomplete(){const menu=$('#composerAutocomplete');autocompleteState.requestId++;menu.hidden=true;menu.replaceChildren();delete menu.dataset.type;autocompleteState.match=null;autocompleteState.items=[];autocompleteState.selected=0;autocompleteState.message=''}
function renderComposerAutocomplete(){const menu=$('#composerAutocomplete'),items=autocompleteState.items;menu.innerHTML='';menu.dataset.type=autocompleteState.match?.type||'';menu.setAttribute('aria-label',autocompleteState.match?.type==='slash'?'Slash command menu':'Mention menu');if(!items.length){const empty=document.createElement('div');empty.className='autocomplete-empty';empty.textContent=autocompleteState.message||(autocompleteState.match?.type==='mention'?'Type to search for files':'No commands');menu.append(empty)}else for(const[index,item]of items.entries()){const button=document.createElement('button');button.type='button';button.className='autocomplete-item'+(index===autocompleteState.selected?' selected':'');button.dataset.autocompleteId=item.id;button.role='option';button.setAttribute('aria-selected',String(index===autocompleteState.selected));button.innerHTML=`${codexIcon(item.icon||'file')}<span class="autocomplete-copy"><strong class="autocomplete-title">${escapeHtml(item.title)}</strong><small class="autocomplete-description">${escapeHtml(item.description)}</small></span>`;button.onpointerdown=event=>event.preventDefault();button.onclick=()=>selectComposerAutocomplete(index);menu.append(button)}menu.hidden=false}
function currentComposerCwd(){if(!state.active&&(state.projectless||!state.workspaceSelected))return'';return state.active?.cwd||state.workspaceContext?.cwd||''}
async function searchMentionSuggestions(match){const query=match.query.trim(),requestId=++autocompleteState.requestId;if(!query){autocompleteState.items=[];autocompleteState.message=!currentComposerCwd()?'Choose a project to mention files':'Type to search for files';renderComposerAutocomplete();return}const tasks=state.threads.filter(thread=>titleOf(thread).toLowerCase().includes(query.toLowerCase())).slice(0,5).map(thread=>({id:`task:${thread.id}`,source:'task',threadId:thread.id,title:titleOf(thread),description:`Task · ${shortPath(thread.cwd)}`,icon:'messageSquare'})),cwd=currentComposerCwd();if(!cwd){autocompleteState.items=[{id:'choose-project',source:'action',title:'Choose project',description:'Select a project to mention files',icon:'folderOpen'},...tasks];autocompleteState.selected=0;autocompleteState.message='';renderComposerAutocomplete();return}autocompleteState.items=[];autocompleteState.message='Searching files…';renderComposerAutocomplete();try{const response=await fetch(`/api/files/search?cwd=${encodeURIComponent(cwd)}&query=${encodeURIComponent(query)}`,{cache:'no-store'}),data=await response.json();if(!response.ok)throw new Error(data.error||'File search unavailable');if(requestId!==autocompleteState.requestId||autocompleteState.match?.type!=='mention'||autocompleteState.match.query!==match.query)return;const files=(data.items||[]).map(item=>{const parts=item.path.split('/');return{id:`${item.kind}:${item.path}`,source:item.kind,path:item.path,title:parts.at(-1),description:parts.length>1?parts.slice(0,-1).join('/'):(item.kind==='folder'?'Folder':'File'),icon:item.kind==='folder'?'folderOpen':'file'}});autocompleteState.items=[...files,...tasks];autocompleteState.selected=0;autocompleteState.message=autocompleteState.items.length?'':'No files or tasks found';renderComposerAutocomplete()}catch(error){if(requestId!==autocompleteState.requestId)return;autocompleteState.items=tasks;autocompleteState.message=tasks.length?'':error.message;renderComposerAutocomplete()}}
function updateComposerAutocomplete(){const input=$('#prompt'),match=getComposerAutocomplete(input.value,input.selectionStart??input.value.length);if(!match){closeComposerAutocomplete();return}autocompleteState.match=match;autocompleteState.selected=0;if(match.type==='slash'){autocompleteState.requestId++;const query=match.query.trim().toLowerCase();autocompleteState.items=slashCommandCatalog.filter(item=>(!item.requiresThread||state.active)&&(item.id.includes(query)||item.title.toLowerCase().includes(query)));autocompleteState.message='';renderComposerAutocomplete();return}searchMentionSuggestions(match)}
function moveComposerAutocomplete(delta){if(!autocompleteState.items.length)return;autocompleteState.selected=(autocompleteState.selected+delta+autocompleteState.items.length)%autocompleteState.items.length;renderComposerAutocomplete()}
function setPlanMode(active){state.planMode=Boolean(active);refreshComposerPlaceholder();syncPermissionControl()}
function applyAutocompleteToken(match,replacement){const input=$('#prompt'),result=applyComposerSuggestion(input.value,match,replacement);input.value=result.text;input.setSelectionRange(result.cursor,result.cursor);resizePrompt()}
function renderContextTray(){const tray=$('#composerContextTray');tray.innerHTML='';for(const mention of state.composerMentions){const chip=document.createElement('div');chip.className='composer-context-chip';chip.dataset.contextId=mention.id;chip.innerHTML=`${codexIcon(mention.icon||'file')}<span>${escapeHtml(mention.title)}</span><button type="button" aria-label="Remove ${escapeHtml(mention.title)}">${codexIcon('x')}</button>`;chip.querySelector('button').onclick=()=>{state.composerMentions=state.composerMentions.filter(item=>item.id!==mention.id);renderContextTray()};tray.append(chip)}tray.hidden=!state.composerMentions.length}
function selectComposerAutocomplete(index=autocompleteState.selected){const item=autocompleteState.items[index],match=autocompleteState.match;if(!item||!match)return;const id=item.id;if(id==='goal'&&!state.active&&!state.workspaceSelected){applyAutocompleteToken(match,'/goal');closeComposerAutocomplete();requireWorkspaceSelection();return}if(item.source==='action'&&id==='choose-project'){closeComposerAutocomplete();openFolderPicker()}else if(item.source==='file'||item.source==='folder'){applyAutocompleteToken(match,`@${item.path}`);if(!state.composerMentions.some(mention=>mention.id===item.id))state.composerMentions.push({...item});renderContextTray();closeComposerAutocomplete()}else if(item.source==='task'){applyAutocompleteToken(match,`@${item.title}`);if(!state.composerMentions.some(mention=>mention.id===item.id))state.composerMentions.push({...item});renderContextTray();closeComposerAutocomplete()}else{if(id==='init')applyAutocompleteToken(match,'/init');closeComposerAutocomplete();if(id==='goal'){applyAutocompleteToken(match,'');if(!$('#prompt').value.trim())$('#prompt').value='';resizePrompt();goalControls.openEditor()}else if(id==='plan'){setPlanMode(!state.planMode);$('#prompt').value='';resizePrompt()}else if(id==='model'){ $('#prompt').value='';resizePrompt();openModelMenu()}else if(id==='reasoning'){ $('#prompt').value='';resizePrompt();openModelMenu()}else if(id==='project'){ $('#prompt').value='';resizePrompt();openFolderPicker()}else if(id==='mcp'){ $('#prompt').value='';resizePrompt();toast('MCP status requires the native desktop status surface.')}else if(id==='compact'){applyAutocompleteToken(match,'/compact');void compactActiveThread()}else if(id==='status'){ $('#prompt').value='';resizePrompt();toast(state.active?.id?`Task ${state.active.id}`:'No active task')}}requestAnimationFrame(()=>$('#prompt').focus())}
function handlePromptInput(){resizePrompt();updateComposerAutocomplete()}
// Preserve IME confirmation keys, including Safari keyCode 229, before handling composer shortcuts.
function handlePromptKeydown(event){if(event.isComposing||event.keyCode===229)return;const open=!$('#composerAutocomplete').hidden;if(open&&!autocompleteState.items.length&&/^\s*\/compact(?:\s|$)/.test($('#prompt').value)&&event.key==='Enter'&&!event.shiftKey){event.preventDefault();$('#composer').requestSubmit();return}if(open){if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();moveComposerAutocomplete(event.key==='ArrowDown'?1:-1);return}if((event.key==='Enter'&&!event.shiftKey)||event.key==='Tab'){event.preventDefault();selectComposerAutocomplete();return}if(event.key==='Escape'){event.preventDefault();closeComposerAutocomplete();return}}if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();$('#composer').requestSubmit()}}
async function resumeActiveThread(threadId=state.active?.id){if(!threadId)return null;const resumed=await rpc('thread/resume',{threadId});if(state.active?.id===threadId){state.active={...state.active,...resumed.thread};renderHeader()}return resumed}
async function ensureGoalThread(){
  if(state.active){
    const threadId=state.active.id;
    if(state.active.canAcceptDirectInput!==true){
      const resumed=await rpc('thread/resume',{threadId});
      if(state.active?.id!==threadId)throw new Error('Task changed. Try again in the selected task.');
      state.active={...state.active,...resumed.thread};renderHeader();
    }
    return state.active;
  }
  if(state.threadLoading||!requireWorkspaceSelection())return null;
  const generation=activeThreadSyncGeneration,startingProjectless=state.projectless,cwd=startingProjectless?state.config.home:currentComposerCwd();
  const result=await rpc('thread/start',{cwd,model:state.selectedModel,reasoningEffort:$('#effortSelect').value,...permissionThreadPolicy(),sessionStartSource:'startup'});
  if(generation!==activeThreadSyncGeneration||state.active)throw new Error('Task changed. Try again in the selected task.');
  state.active={...result.thread,projectless:startingProjectless};rememberActiveThread(state.active.id);
  if(!state.threads.some(thread=>thread.id===state.active.id))state.threads.unshift(state.active);
  goalControls.selectThread(state.active.id,{preserveEditor:true});
  renderContextUsage();renderHeader();renderThreads();scheduleActiveThreadSync(0);
  return state.active;
}
function steeringBubble(clientId){return $('#conversation').querySelector(`.user-turn[data-client-user-message-id="${CSS.escape(clientId)}"]`)}
function renderSteeringDelivery(entry,el=steeringBubble(entry.clientId)){
  if(!el)return;
  el.classList.toggle('steering-user-turn',entry.status!=='received');el.dataset.steeringState=entry.status;
  let notice=el.querySelector('.steering-delivery');
  if(entry.status==='received'){notice?.remove();return}
  if(!notice){notice=document.createElement('div');notice.className='steering-delivery';notice.setAttribute('role','status');el.append(notice)}
  const labels={sending:'Sending guidance…',queued:'Will be read at the next tool call',unconfirmed:'Checking whether guidance was received…',interrupting:'Interrupting to send guidance…',notDelivered:'Guidance was not received'};
  notice.replaceChildren();const label=document.createElement('span');label.textContent=t(labels[entry.status]||labels.queued);notice.append(label);
  if(['sending','queued','unconfirmed'].includes(entry.status)){
    const button=document.createElement('button');button.type='button';button.textContent=t('Esc — interrupt and send now');button.onclick=()=>void interruptForSteering(entry.threadId,entry.turnId);notice.append(button);
  }else if(entry.status==='notDelivered'){
    const button=document.createElement('button');button.type='button';button.textContent=t('Restore message');button.onclick=()=>{
      if(state.active?.id!==entry.threadId)return;
      $('#prompt').value=[$('#prompt').value,userMessageContent({content:entry.input}).text].filter(Boolean).join('\n\n');composerAttachments?.restore(entry.files||[]);pendingSteers.remove(entry.clientId);removeOptimisticBubble(entry.clientId);resizePrompt();$('#prompt').focus();
    };notice.append(button);
  }
}
function removeOptimisticBubble(clientId){const el=steeringBubble(clientId);if(!el||el.dataset.optimisticUser!=='true')return;el.remove();for(const[id,node]of state.items)if(node===el)state.items.delete(id)}
function renderPendingSteers(){
  renderCompactionPending();
  for(const entry of pendingSteers.list(state.active?.id)){
    if(!steeringBubble(entry.clientId))upsertItem({id:`local-${entry.clientId}`,clientId:entry.clientId,type:'userMessage',content:entry.input},entry.turnId,$('#conversation'),false);
    const status=state.turns.get(entry.turnId)?.dataset.turnStatus;
    if(status&&status!=='inProgress')pendingSteers.update(entry.clientId,'notDelivered');
    renderSteeringDelivery(entry);
  }
}
async function interruptForSteering(threadId=state.active?.id,turnId=activeTurnId()){
  if(!threadId||!turnId)return;
  const key=`${threadId}:${turnId}`;if(steeringInterrupts.has(key))return;
  const turnOptions={model:state.selectedModel,effort:$('#effortSelect').value,cwd:state.active?.cwd,...permissionTurnPolicy(state.active?.cwd)};
  let complete;const completed=new Promise(resolve=>{complete=resolve});
  steeringInterrupts.set(key,{complete});syncComposerSubmitState();
  let timeout,poll;
  try{
    // Admission must settle first: a late steer must never land after the
    // interrupt that was intended to discard it.
    await Promise.allSettled(pendingSteers.list(threadId,turnId).map(entry=>steeringSubmissions.get(entry.clientId)).filter(Boolean));
    for(const entry of pendingSteers.list(threadId,turnId)){pendingSteers.update(entry.clientId,'interrupting');renderSteeringDelivery(entry)}
    const timeline=state.active?.id===threadId&&state.turns.get(turnId);
    if(timeline&&timeline.dataset.turnStatus&&timeline.dataset.turnStatus!=='inProgress')complete({id:turnId,status:timeline.dataset.turnStatus});
    else{
      await rpc('turn/interrupt',{threadId,turnId});
      // A reconnect can hide the notification; confirm termination from native
      // history before starting anything, rather than treating the RPC as done.
      poll=setTimeout(async()=>{try{const turn=await latestThreadTurn(threadId);if(turn?.id===turnId&&turn.status!=='inProgress'){if(threadId===state.active?.id)syncTurnSnapshot(turn,threadId);complete(turn)}}catch{}},1200);
    }
    const turn=await Promise.race([completed,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error(t('Could not confirm interruption. Guidance has been kept.'))),15000)})]);
    if(turn.status!=='interrupted'&&turn.status!=='completed')throw new Error(t('The task ended with an error. Guidance has been kept.'));
    const remaining=pendingSteers.list(threadId,turnId);
    if(!remaining.length)return;
    const input=remaining.flatMap(entry=>entry.input),clientId=createClientMessageId(),localId=`local-${clientId}`,visible=state.active?.id===threadId;
    if(visible){for(const entry of remaining)removeOptimisticBubble(entry.clientId);upsertItem({id:localId,clientId,type:'userMessage',content:input},'optimistic')}
    try{
      const result=await rpc('turn/start',{threadId,clientUserMessageId:clientId,input,...turnOptions});
      for(const entry of remaining)pendingSteers.remove(entry.clientId);
      if(threadId===state.active?.id&&result?.turn?.id){renderTurn({...result.turn,status:result.turn.status||'inProgress'},$('#conversation'),true);syncTurnRuntime(result.turn);scrollBottom()}
    }catch(error){
      if(visible){removeOptimisticBubble(clientId);renderPendingSteers()}
      throw error;
    }
  }catch(error){
    for(const entry of pendingSteers.list(threadId,turnId)){pendingSteers.update(entry.clientId,'notDelivered');renderSteeringDelivery(entry)}
    if(threadId===state.active?.id){toast(error.message,5200);showConversationError(error,{turnId})}
  }finally{clearTimeout(timeout);clearTimeout(poll);steeringInterrupts.delete(key);syncComposerSubmitState()}
}
async function submitPrompt(event){
  event.preventDefault();if(state.threadLoading||promptAdmissions.has(activeThreadSyncGeneration)&&!activeTurnId())return;closeComposerAutocomplete();closePermissionMenu();
  const input=$('#prompt'),text=input.value.trim(),turnId=activeTurnId();
  if([...steeringInterrupts.keys()].some(key=>key.startsWith(`${state.active?.id}:`)))return;
  if(/^\/compact(?:\s|$)/.test(text)){if(text!=='/compact')toast(t('Usage: /compact'));else await compactActiveThread();return}
  if(compactionRequests.has(state.active?.id)&&(text||composerAttachments?.hasFiles())){toast(t('Context compaction is already in progress'));return}
  if(parseGoalCommand(text)){
    if(!state.active&&!requireWorkspaceSelection())return;
    const draft=input.value,result=await goalControls.command(text);
    if(result?.accepted&&input.value===draft){input.value='';resizePrompt()}
    return;
  }
  if(turnId&&!text&&!composerAttachments?.hasFiles()){if(state.active)await rpc('turn/interrupt',{threadId:state.active.id,turnId});return}
  if(!text&&!composerAttachments?.hasFiles())return;
  if(composerAttachments?.isUploading()){toast(t('Please wait for attachments to finish uploading.'));return}
  if(!requireWorkspaceSelection())return;
  const files=composerAttachments?.take()||[],userInput=attachmentInput(text,files),mentions=state.composerMentions;
  const generation=activeThreadSyncGeneration,sourceThread=state.active;
  const clientId=createClientMessageId(),optimistic={id:`local-${clientId}`,clientId,type:'userMessage',content:userInput};
  upsertItem(optimistic,turnId||'optimistic');
  input.value='';state.composerMentions=[];renderContextTray();resizePrompt();
  const restoreInput=()=>{
    if(generation!==activeThreadSyncGeneration)return;
    state.items.get(optimistic.id)?.remove();state.items.delete(optimistic.id);
    input.value=input.value?`${text}\n\n${input.value}`:text;state.composerMentions=[...mentions,...state.composerMentions];composerAttachments?.restore(files);renderContextTray();resizePrompt();
  };
  if(turnId){
    const steeringThreadId=state.active?.id;let resumed=false;
    const entry=pendingSteers.add({clientId,threadId:steeringThreadId,turnId,input:userInput,files});renderSteeringDelivery(entry);
    let finishSubmission;steeringSubmissions.set(clientId,new Promise(resolve=>{finishSubmission=resolve}));
    const send=async()=>{
      await rpc('turn/steer',{threadId:steeringThreadId,expectedTurnId:turnId,clientUserMessageId:clientId,input:userInput});
      const queued=pendingSteers.update(clientId,'queued');if(queued)renderSteeringDelivery(queued);
    };
    try{
      if(state.active?.canAcceptDirectInput!==true){await resumeActiveThread(steeringThreadId);resumed=true}
      await send();
    }catch(error){
      let failure=error;
      if(!resumed&&bridgeErrorCode(error)===THREAD_NOT_FOUND&&state.active){
        try{await resumeActiveThread(steeringThreadId);await send();return}catch(resumeError){failure=resumeError}
      }
      if(failure?.silentTransportSwitch){const uncertain=pendingSteers.update(clientId,'unconfirmed');if(uncertain)renderSteeringDelivery(uncertain);scheduleActiveThreadSync(0)}
      else if(pendingSteers.remove(clientId))restoreInput();
      if(!failure?.silentTransportSwitch){toast(t(threadInputErrorMessage(failure)),5200);if(steeringThreadId===state.active?.id)showConversationError({...failure,message:threadInputErrorMessage(failure)},{turnId})}
    }finally{finishSubmission();steeringSubmissions.delete(clientId)}
    return;
  }
  let target=sourceThread,requestThreadId=sourceThread?.id;
  const startingProjectless=state.projectless,cwd=target?.cwd||(startingProjectless?state.config.home:currentComposerCwd());
  const model=state.selectedModel,effort=$('#effortSelect').value,threadPolicy=permissionThreadPolicy(),turnPolicy=permissionTurnPolicy(cwd);
  promptAdmissions.add(generation);syncComposerSubmitState();
  try{
    if(!target){
      const res=await rpc('thread/start',{cwd,model,...threadPolicy,sessionStartSource:'startup'});
      target={...res.thread,projectless:startingProjectless};requestThreadId=target.id;
      if(generation===activeThreadSyncGeneration){
        state.active=target;rememberActiveThread(target.id);
        if(!state.threads.some(thread=>thread.id===target.id))state.threads.unshift(target);
        renderContextUsage();renderHeader();renderThreads();
      }
    }else if(target.canAcceptDirectInput!==true){
      const resumed=await rpc('thread/resume',{threadId:requestThreadId});target={...target,...resumed.thread};
      if(generation===activeThreadSyncGeneration&&requestThreadId===state.active?.id){state.active=target;renderHeader()}
    }
    const result=await rpc('turn/start',{threadId:requestThreadId,clientUserMessageId:clientId,input:userInput,model,effort,cwd:target.cwd||cwd,...turnPolicy});
    if(generation===activeThreadSyncGeneration&&requestThreadId===state.active?.id&&result?.turn?.id){
      const turn={...result.turn,status:result.turn.status||'inProgress'};
      renderTurn(turn,$('#conversation'),true);syncTurnRuntime(turn);scrollBottom();
    }
  }catch(error){
    restoreInput();
    if(!error?.silentTransportSwitch){toast(t(threadInputErrorMessage(error)),5200);if(generation===activeThreadSyncGeneration&&requestThreadId===state.active?.id)showConversationError(error,{terminal:true})}
  }finally{promptAdmissions.delete(generation);syncComposerSubmitState()}

}
function threadSummarySignature(threads){return JSON.stringify(threads.map(thread=>[thread.id,thread.name,thread.preview,thread.pinnedAt,thread.updatedAt,thread.recencyAt,thread.status]))}
function applyThreadSummaries(threads){const nextSignature=threadSummarySignature(threads),changed=nextSignature!==threadListSignature;threadListSignature=nextSignature;state.threads=threads;const summary=state.active&&threads.find(thread=>thread.id===state.active.id);if(summary){const turns=state.active.turns;const oldName=state.active.name;state.active={...state.active,...summary,turns};if(oldName!==state.active.name)renderHeader();if(summary.status?.type==='active')scheduleActiveThreadSync(0)}if(changed)renderThreads()}
function scheduleThreadListRefresh(delay=THREAD_LIST_POLL_MS){clearTimeout(threadListTimer);threadListTimer=setTimeout(refreshThreadList,document.visibilityState==='hidden'?Math.max(delay,8000):delay)}
async function refreshThreadList(){if(threadListInFlight){scheduleThreadListRefresh(1000);return}threadListInFlight=true;try{const result=await rpc('thread/list',{limit:50,sortKey:'recency_at',sortDirection:'desc'});applyThreadSummaries(result.data||[])}catch{}finally{threadListInFlight=false;scheduleThreadListRefresh()}}
function refreshThreadsSoon(){scheduleThreadListRefresh(600)}
function resetActiveThreadSync(){activeThreadSyncGeneration++;clearTimeout(activeThreadSyncTimer);activeThreadSyncTimer=null;activeThreadSyncSignature=''}
function scheduleActiveThreadSync(delay=ACTIVE_THREAD_SYNC_IDLE_MS){clearTimeout(activeThreadSyncTimer);if(!state.active)return;activeThreadSyncTimer=setTimeout(syncActiveThread,document.visibilityState==='hidden'?Math.max(delay,6000):delay)}
async function latestThreadTurn(threadId){try{const live=await rpc('host/thread/live',{threadId});if(live?.active&&live.turn)return live.turn}catch{}try{const result=await rpc('thread/turns/list',{threadId,limit:1,sortDirection:'desc',itemsView:'full'});return result.data?.[0]||null}catch{const result=await rpc('thread/read',{threadId,includeTurns:true});return result.thread?.turns?.at(-1)||null}}
function activeTurnId(){return $('#sendButton')?.dataset.turnId||''}
function syncComposerSubmitState(){const button=$('#sendButton');if(!button)return;const hasInput=Boolean($('#prompt').value.trim()||composerAttachments?.hasFiles()),mode=activeTurnId()?(hasInput?'steer':'stop'):'send',label=mode==='stop'?'Stop':mode==='steer'?'Steer':'Send message';button.disabled=Boolean(state.threadLoading||promptAdmissions.has(activeThreadSyncGeneration)&&!activeTurnId()||composerAttachments?.isUploading()&&mode!=='stop'||compactionRequests.has(state.active?.id)&&!activeTurnId()||[...steeringInterrupts.keys()].some(key=>key.startsWith(`${state.active?.id}:`)));button.dataset.submitMode=mode;button.classList.toggle('stop',mode==='stop');button.classList.toggle('steer',mode==='steer');button.innerHTML=codexIcon(mode==='stop'?'square':'arrowUp');button.title=t(label);button.setAttribute('aria-label',t(label))}
function setActiveTurnId(turnId=''){const button=$('#sendButton');if(!button)return;button.dataset.turnId=turnId||'';syncComposerSubmitState()}
function syncTurnRuntime(turn){const knownStatus=state.turns.get(turn?.id)?.dataset.turnStatus,active=turn?.status==='inProgress'&&(!knownStatus||knownStatus==='inProgress');if(active)setActiveTurnId(turn.id);else if(activeTurnId()===turn?.id)setActiveTurnId('')}
function syncTurnSnapshot(turn,threadId=state.active?.id){if(!turn||!threadId||threadId!==state.active?.id)return false;const root=$('#conversation'),nearBottom=root.scrollHeight-root.scrollTop-root.clientHeight<80,turns=state.active.turns||[],index=turns.findIndex(existing=>existing.id===turn.id);if(index<0)turns.push(turn);else turns[index]=turn;state.active.turns=turns;root.querySelectorAll('.conversation-loading').forEach(node=>node.remove());renderTurn(turn,root);renderPendingSteers();syncTurnRuntime(turn);if(nearBottom)scrollBottom();return true}
async function syncActiveThread(){if(activeThreadSyncInFlight||!state.active){scheduleActiveThreadSync();return}const generation=activeThreadSyncGeneration,threadId=state.active.id;activeThreadSyncInFlight=true;void goalControls?.refresh();let nextDelay=ACTIVE_THREAD_SYNC_IDLE_MS;try{const turn=await latestThreadTurn(threadId);if(generation!==activeThreadSyncGeneration||threadId!==state.active?.id)return;reconcileCompactionRequest(threadId,turn);if(turn){const signature=JSON.stringify(turn);nextDelay=turn.status==='inProgress'?ACTIVE_THREAD_SYNC_ACTIVE_MS:ACTIVE_THREAD_SYNC_IDLE_MS;if(signature!==activeThreadSyncSignature){activeThreadSyncSignature=signature;syncTurnSnapshot(turn,threadId)}}}catch{}finally{activeThreadSyncInFlight=false;if(generation===activeThreadSyncGeneration&&threadId===state.active?.id)scheduleActiveThreadSync(nextDelay)}}
function resizePrompt(){const e=$('#prompt');e.style.height='auto';e.style.height=Math.min(190,e.scrollHeight)+'px';syncComposerSubmitState()}
function scrollBottom(){requestAnimationFrame(()=>{$('#conversation').scrollTop=$('#conversation').scrollHeight})}
function scrollOpenedThreadToBottom(){const root=$('#conversation'),apply=()=>{root.scrollTop=root.scrollHeight};requestAnimationFrame(()=>{apply();requestAnimationFrame(apply)})}
function formatThreadTime(date){const pad=value=>String(value).padStart(2,'0');return `${pad(date.getMonth()+1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`}
function escapeHtml(v=''){return String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function toast(text,duration=2200){const e=$('#toast');e.textContent=text;e.classList.add('show');clearTimeout(toast.t);toast.t=setTimeout(()=>e.classList.remove('show'),duration)}
function syncSummaryPanel(){const workspace=state.projectless?'No project':($('#projectName').textContent||'Local workspace');$('#summaryWorkspace').textContent=workspace;$('#summaryBranch').textContent=state.projectless?'':state.active?.source==='remote'?'Remote workspace':'Local workspace'}
function overlayPanelsEnabled(){return matchMedia('(max-width:1200px)').matches}
function setOverlayBackgroundInert(inert){for(const selector of ['.topbar','.sidebar','.conversation-shell','.bottom-panel']){const node=$(selector);if(node)node.inert=inert}}
function focusPanel(panel,closeButton){if(!overlayPanelsEnabled())return;setOverlayBackgroundInert(true);panel.setAttribute('aria-modal','true');requestAnimationFrame(()=>closeButton.focus())}
function restorePanelFocus(panel,target){panel.setAttribute('aria-modal','false');if(!document.body.classList.contains('side-panel-open')&&!document.body.classList.contains('summary-panel-open'))setOverlayBackgroundInert(false);if(overlayPanelsEnabled()&&target?.isConnected)requestAnimationFrame(()=>target.focus())}
function syncOverlayPanelMode(){const overlay=overlayPanelsEnabled(),sideOpen=document.body.classList.contains('side-panel-open'),summaryOpen=document.body.classList.contains('summary-panel-open');setOverlayBackgroundInert(overlay&&(sideOpen||summaryOpen));$('#sidePanel').setAttribute('aria-modal',String(overlay&&sideOpen));$('#summaryPanel').setAttribute('aria-modal',String(overlay&&summaryOpen));if(overlay){const panel=summaryOpen?$('#summaryPanel'):sideOpen?$('#sidePanel'):null,close=summaryOpen?$('#closeSummaryPanel'):sideOpen?$('#closeSidePanel'):null;if(panel&&close&&!panel.contains(document.activeElement))requestAnimationFrame(()=>close.focus())}renderChanges()}
function setSidebarOpen(open){const sidebar=$('#sidebar'),mobile=mobileSidebarEnabled();document.body.classList.toggle('sidebar-hidden',!mobile&&!open);sidebar.classList.toggle('mobile-open',mobile&&open);const visible=mobile?sidebar.classList.contains('mobile-open'):!document.body.classList.contains('sidebar-hidden');$('#toggleSidebar').setAttribute('aria-expanded',String(visible));$('#toggleSidebar').setAttribute('aria-pressed',String(visible))}
function syncSidebarLayout(){const mobile=mobileSidebarEnabled();if(mobile===sidebarLayoutMobile)return;sidebarLayoutMobile=mobile;setSidebarOpen(!mobile)}
function setBrowserStatus(text,tone='ready'){const status=$('#browserStatus');status.dataset.tone=tone;$('#browserStatusText').textContent=text}
function updateBrowserControls(){const current=browserState.history[browserState.index]||'';$('#browserBack').disabled=browserState.index<=0;$('#browserForward').disabled=browserState.index<0||browserState.index>=browserState.history.length-1;$('#browserRefresh').disabled=!current;for(const link of [$('#browserOpenExternal'),$('#browserNoticeExternal')]){link.hidden=!current;if(current)link.href=current}}
function showBrowserNotice(title,description){$('#browserNoticeTitle').textContent=title;$('#browserNoticeDescription').textContent=description;$('#browserNotice').hidden=false;$('#browserLoading').hidden=true;$('#browserFrameShell').setAttribute('aria-busy','false');setBrowserStatus(title,'error')}
function finishBrowserLoad(requestId){if(requestId!==browserState.loadRequest)return;clearTimeout(browserState.loadTimer);$('#browserLoading').hidden=true;$('#browserNotice').hidden=true;$('#browserFrameShell').setAttribute('aria-busy','false');setBrowserStatus('Loaded. If the page is blank, the site may block embedding.','loaded')}
function navigateBrowser(value,{push=true}={}){const result=normalizeBrowserUrl(value);if(result.error){showBrowserNotice('Invalid address',result.error);$('#browserUrl').setAttribute('aria-invalid','true');return false}const url=result.url;$('#browserUrl').removeAttribute('aria-invalid');$('#browserUrl').value=url;if(push&&browserState.history[browserState.index]!==url){browserState.history=browserState.history.slice(0,browserState.index+1);browserState.history.push(url);browserState.index=browserState.history.length-1}const requestId=++browserState.loadRequest,frame=$('#browserFrame');clearTimeout(browserState.loadTimer);$('#browserEmpty').hidden=true;$('#browserNotice').hidden=true;$('#browserLoading').hidden=false;frame.hidden=false;frame.setAttribute('sandbox',browserSandboxFor(url,location.href));$('#browserFrameShell').setAttribute('aria-busy','true');setBrowserStatus('Loading page...','loading');updateBrowserControls();frame.onload=()=>finishBrowserLoad(requestId);frame.onerror=()=>requestId===browserState.loadRequest&&showBrowserNotice('Page could not be loaded','The site did not complete the embedded request. Open it externally to continue.');frame.src=url;browserState.loadTimer=setTimeout(()=>{if(requestId===browserState.loadRequest)showBrowserNotice('Page may have blocked embedding','This site did not finish loading in the panel. It may block embedded browsers; you can open it externally instead.')},10000);return true}
function moveBrowserHistory(delta){const next=browserState.index+delta;if(next<0||next>=browserState.history.length)return;browserState.index=next;navigateBrowser(browserState.history[next],{push:false});updateBrowserControls()}
function openBrowserPanel(){const tab=$('#utilityTab');tab.textContent='Browser';tab.dataset.sidePanelTab='browser';tab.hidden=false;setSidePanelOpen(true,false);setSidePanelView('browser','Browser');updateBrowserControls();if(browserState.index<0&&!overlayPanelsEnabled())requestAnimationFrame(()=>$('#browserUrl').focus())}
function setSidePanelView(view,title){const launcher=view==='launcher',review=view==='review',utility=view==='utility',browser=view==='browser',terminal=view==='terminal',sideTask=view==='side-task';$('#sidePanelLauncher').hidden=!launcher;$('#reviewPanelContent').hidden=!review;$('#browserPanel').hidden=!browser;$('#sideTerminalPanel').hidden=!terminal;$('#sideTaskPanel').hidden=!sideTask;$('#utilityPanelContent').hidden=!utility;for(const tab of document.querySelectorAll('.side-panel-tab')){const selected=tab.dataset.sidePanelTab===view;tab.classList.toggle('active',selected);tab.setAttribute('aria-selected',String(selected))}$('#newTab').hidden=false;if(review)$('#reviewTab').hidden=false;if(utility||browser||terminal||sideTask)$('#utilityTab').hidden=false;$('#sidePanelTitle').textContent=title||(launcher?'New tab':review?'Review':$('#utilityTab').textContent);renderChanges();if(terminal)requestAnimationFrame(()=>{initializeTerminal(terminalStates.side);fitTerminal(terminalStates.side);terminalStates.side.term?.focus()});if(sideTask)renderSideTasks();if(overlayPanelsEnabled()&&document.body.classList.contains('side-panel-open'))requestAnimationFrame(()=>$('#closeSidePanel').focus())}
function openReviewPanel(review=null){state.activeReview=review||[...state.turnDiffs.values()].at(-1)||state.activeReview;setSidePanelOpen(true,false);setSidePanelView('review','Review')}
function openUtilityPanel(kind){if(kind==='browser'){openBrowserPanel();return}const tab=$('#utilityTab');if(kind==='terminal'){tab.textContent='Terminal';tab.dataset.sidePanelTab='terminal';setSidePanelOpen(true,false);setSidePanelView('terminal','Terminal');return}if(kind==='side-task'){tab.textContent='Side tasks';tab.dataset.sidePanelTab='side-task';setSidePanelOpen(true,false);setSidePanelView('side-task','Side tasks');return}const labels={files:['Files','folderOpen','Choose or switch the local project folder available to this WebUI.']},entry=labels[kind];if(!entry)return;const[title,icon,description]=entry;tab.textContent=title;tab.dataset.sidePanelTab='utility';$('#utilityPanelTitle').textContent=title;$('#utilityPanelDescription').textContent=description;$('#utilityPanelIcon').innerHTML=codexIcon(icon);const action=$('#utilityPanelAction');action.hidden=false;action.textContent='Choose project folder';action.onclick=openFolderPicker;setSidePanelOpen(true,false);setSidePanelView('utility',title)}
function setSidePanelOpen(open,reset=true){const panel=$('#sidePanel'),trigger=$('#toggleSidePanel'),wasOpen=!panel.hidden;if(open){setSummaryPanelOpen(false);if(!wasOpen){sidePanelReturnFocus=document.activeElement instanceof HTMLElement?document.activeElement:trigger;panel.hidden=false;document.body.classList.add('side-panel-open');trigger.setAttribute('aria-pressed','true');trigger.setAttribute('aria-expanded','true')}if(reset)setSidePanelView('launcher','New tab');if(!wasOpen)focusPanel(panel,$('#closeSidePanel'))}else{panel.hidden=true;document.body.classList.remove('side-panel-open','review-split-open');trigger.setAttribute('aria-pressed','false');trigger.setAttribute('aria-expanded','false');restorePanelFocus(panel,sidePanelReturnFocus);sidePanelReturnFocus=null}}
function setSummaryPanelOpen(open){const panel=$('#summaryPanel'),trigger=$('#toggleSummaryPanel');if(open){setSidePanelOpen(false,false);summaryPanelReturnFocus=document.activeElement instanceof HTMLElement?document.activeElement:trigger;panel.hidden=false;document.body.classList.add('summary-panel-open');trigger.setAttribute('aria-pressed','true');trigger.setAttribute('aria-expanded','true');syncSummaryPanel();focusPanel(panel,$('#closeSummaryPanel'))}else{panel.hidden=true;document.body.classList.remove('summary-panel-open');trigger.setAttribute('aria-pressed','false');trigger.setAttribute('aria-expanded','false');restorePanelFocus(panel,summaryPanelReturnFocus);summaryPanelReturnFocus=null}}
function closeImageViewer(){const dialog=$('#imageViewer');if(dialog.open)dialog.close()}
function openImageViewer(source,title='Image',path=''){const dialog=$('#imageViewer'),image=$('#imageViewerImage');imageViewerReturnFocus=document.activeElement instanceof HTMLElement?document.activeElement:null;$('#imageViewerTitle').textContent=title||'Image';$('#imageViewerPath').textContent=path||title||'';$('#imageViewerError').hidden=true;image.hidden=false;image.alt=title||'';image.src=source;$('#imageViewerOriginal').href=source;if(!dialog.open)dialog.showModal();requestAnimationFrame(()=>$('#closeImageViewer').focus())}
function currentTerminalCwd(){return state.active?.cwd||state.workspaceContext?.cwd||state.config.home||'.'}
function terminalIsVisible(terminalState){const host=$(`#${terminalState.hostId}`),panel=$(`#${terminalState.panelId}`);return host&&!host.hidden&&panel&&!panel.hidden}
function fitTerminal(terminalState){const host=$(`#${terminalState.hostId}`);if(!terminalState.fit||!terminalIsVisible(terminalState)||host.clientWidth<1||host.clientHeight<1)return;try{terminalState.fit.fit()}catch{}}
function sendTerminalResize(terminalState){const ws=terminalState.ws,term=terminalState.term;if(ws?.readyState===WebSocket.OPEN&&term)ws.send(JSON.stringify({type:'resize',cols:term.cols,rows:term.rows}))}
function connectTerminal(terminalState){if(terminalState.ws&&[WebSocket.OPEN,WebSocket.CONNECTING].includes(terminalState.ws.readyState))return;clearTimeout(terminalState.reconnectTimer);const proto=location.protocol==='https:'?'wss:':'ws:',host=$(`#${terminalState.hostId}`),ws=new WebSocket(`${proto}//${location.host}/terminal?cwd=${encodeURIComponent(currentTerminalCwd())}`);terminalState.ws=ws;ws.binaryType='arraybuffer';host.dataset.connected='false';ws.onopen=()=>{host.dataset.connected='true';requestAnimationFrame(()=>{fitTerminal(terminalState);sendTerminalResize(terminalState);terminalState.term?.focus()})};ws.onmessage=async event=>{const data=event.data instanceof Blob?new Uint8Array(await event.data.arrayBuffer()):event.data instanceof ArrayBuffer?new Uint8Array(event.data):String(event.data);terminalState.term?.write(data)};ws.onerror=()=>ws.close();ws.onclose=()=>{host.dataset.connected='false';if(terminalState.ws===ws)terminalState.ws=null;if(terminalIsVisible(terminalState))terminalState.reconnectTimer=setTimeout(()=>connectTerminal(terminalState),1000)}}
function initializeTerminal(terminalState){if(terminalState.term){connectTerminal(terminalState);requestAnimationFrame(()=>fitTerminal(terminalState));return}const dark=matchMedia('(prefers-color-scheme:dark)').matches,host=$(`#${terminalState.hostId}`),term=new Terminal({cursorBlink:true,cursorStyle:'block',fontFamily:'ui-monospace, "SFMono-Regular", "SF Mono", Menlo, Consolas, monospace',fontSize:12,lineHeight:1.2,scrollback:5000,theme:dark?{background:'#181818',foreground:'#f2f2f2',cursor:'#f2f2f2',selectionBackground:'#3b4a5a'}:{background:'#ffffff',foreground:'#0d0d0d',cursor:'#0d0d0d',selectionBackground:'#c8dcf4'}}),fit=new FitAddon;term.loadAddon(fit);term.open(host);terminalState.term=term;terminalState.fit=fit;term.onData(data=>{const ws=terminalState.ws;if(ws?.readyState===WebSocket.OPEN)ws.send(new TextEncoder().encode(data))});term.onResize(()=>sendTerminalResize(terminalState));terminalState.resizeObserver=new ResizeObserver(()=>requestAnimationFrame(()=>fitTerminal(terminalState)));terminalState.resizeObserver.observe(host);connectTerminal(terminalState);globalThis.__codexTerminals=terminalStates;if(terminalState===terminalStates.bottom)globalThis.__codexTerminal={term,fit,state:terminalState}}
function setBottomPanelView(kind='launcher'){const launcher=kind==='launcher',terminal=kind==='terminal',labels={browser:['Browser','globe','Open Browser from the right panel to keep it beside the chat.'],files:['Files','folderOpen','Choose or switch the local project folder available to this WebUI.']};$('#bottomPanelLauncher').hidden=!launcher;$('#terminalHost').hidden=!terminal;$('#bottomPanelUtility').hidden=launcher||terminal;$('#bottomPanelTab').textContent=launcher?'New tab':terminal?'Terminal':labels[kind]?.[0]||'New tab';if(launcher)return;bottomPanelLastView=kind;if(terminal){initializeTerminal(terminalStates.bottom);requestAnimationFrame(()=>{fitTerminal(terminalStates.bottom);terminalStates.bottom.term?.focus()});return}const[title,icon,description]=labels[kind];$('#bottomPanelIcon').innerHTML=codexIcon(icon);$('#bottomPanelUtilityTitle').textContent=title;$('#bottomPanelDescription').textContent=description;const action=$('#bottomPanelAction');action.hidden=kind!=='files';action.textContent='Choose project folder';action.onclick=kind==='files'?openFolderPicker:null}
function setBottomPanelOpen(open){const panel=$('#bottomPanel');panel.hidden=!open;document.body.classList.toggle('bottom-panel-open',open);$('#toggleBottomPanel').setAttribute('aria-pressed',String(open));$('#toggleBottomPanel').setAttribute('aria-expanded',String(open));if(open)setBottomPanelView(bottomPanelLastView||'launcher')}
function setSidebarSearchOpen(open){const panel=$('#sidebarSearchPanel'),input=$('#threadSearch');panel.hidden=!open;$('#sidebarSearchButton').setAttribute('aria-expanded',String(open));if(open){requestAnimationFrame(()=>input.focus());return}if(input.value){input.value='';renderThreads()}}
function setSidebarHelpOpen(open){$('#sidebarHelpMenu').hidden=!open;$('#sidebarHelpButton').setAttribute('aria-expanded',String(open))}

$('#newTab').onclick=()=>setSidePanelView('launcher','New tab');$('#reviewTab').onclick=()=>openReviewPanel(state.activeReview);$('#utilityTab').onclick=()=>setSidePanelView($('#utilityTab').dataset.sidePanelTab,$('#utilityTab').textContent);$('#openSidePanelTab').onclick=()=>setSidePanelView('launcher','New tab');for(const action of document.querySelectorAll('[data-side-panel-action]'))action.onclick=()=>action.dataset.sidePanelAction==='review'?openReviewPanel():openUtilityPanel(action.dataset.sidePanelAction);$('#browserAddressForm').onsubmit=event=>{event.preventDefault();navigateBrowser($('#browserUrl').value)};$('#browserBack').onclick=()=>moveBrowserHistory(-1);$('#browserForward').onclick=()=>moveBrowserHistory(1);$('#browserRefresh').onclick=()=>browserState.index>=0&&navigateBrowser(browserState.history[browserState.index],{push:false});$('#bottomPanelTab').onclick=()=>setBottomPanelView();for(const action of document.querySelectorAll('[data-bottom-panel-action]'))action.onclick=()=>setBottomPanelView(action.dataset.bottomPanelAction);$('#reviewMode').onclick=()=>{reviewPreferences.mode=reviewPreferences.mode==='unified'?'split':'unified';saveReviewPreferences();renderChanges()};$('#reviewWrap').onclick=()=>{reviewPreferences.wrap=!reviewPreferences.wrap;saveReviewPreferences();renderChanges()};$('#reviewExpand').onclick=()=>{reviewPreferences.expanded=!reviewPreferences.expanded;saveReviewPreferences();renderChanges()};$('#reviewPatch').onclick=applyActiveReviewPatch;$('#composer').addEventListener('submit',submitPrompt);$('#prompt').addEventListener('input',handlePromptInput);$('#prompt').addEventListener('keydown',handlePromptKeydown);$('#threadSearch').addEventListener('input',renderThreads);$('#modelButton').addEventListener('click',toggleModelMenu);$('#modeButton').onclick=togglePermissionMenu;$('#confirmFullAccess').onclick=()=>{const action=pendingFullAccessAction;$('#fullAccessDialog').close();if(action==='enable')setPermissionVisibility('fullAccess',true);else setPermissionMode('full-access');pendingFullAccessAction='select'};$('#fullAccessDialog').addEventListener('close',()=>{pendingFullAccessAction='select';syncPermissionSettings()});document.querySelector('[data-composer-control="dictation"]').onclick=()=>toast('Dictation requires the native desktop audio bridge.');$('#newTask').onclick=startNewTask;$('#projectButton').onclick=openFolderPicker;$('#newProjectButton').onclick=openFolderPicker;$('#composerProjectButton').onclick=openFolderPicker;$('#projectlessOption').onclick=useProjectless;$('#accountButton').onclick=e=>{e.stopPropagation();if(state.account?.type==='chatgpt')toggleAccountMenu();else openSettings('general')};$('#folderGo').onclick=()=>loadFolders($('#folderPathInput').value);$('#folderPathInput').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();loadFolders(e.currentTarget.value)}};$('#folderUp').onclick=()=>folderBrowse.parent&&loadFolders(folderBrowse.parent);$('#folderConfirm').onclick=useSelectedFolder;$('#toggleSummaryPanel').onclick=()=>setSummaryPanelOpen($('#summaryPanel').hidden);$('#closeImageViewer').onclick=closeImageViewer;$('#imageViewerImage').onload=()=>{$('#imageViewerImage').hidden=false;$('#imageViewerError').hidden=true};$('#imageViewerImage').onerror=()=>{$('#imageViewerImage').hidden=true;$('#imageViewerError').hidden=false};$('#imageViewer').addEventListener('click',event=>{if(event.target===event.currentTarget)closeImageViewer()});$('#imageViewer').addEventListener('close',()=>{const image=$('#imageViewerImage');image.removeAttribute('src');if(imageViewerReturnFocus?.isConnected)imageViewerReturnFocus.focus();imageViewerReturnFocus=null});function mobileSidebarEnabled(){return document.documentElement.classList.contains('mobile-device')||innerWidth<720}
$('#sidebarSearchButton').onclick=event=>{event.stopPropagation();setSidebarSearchOpen($('#sidebarSearchPanel').hidden)};$('#sidebarSearchClose').onclick=()=>setSidebarSearchOpen(false);$('#sidebarHelpButton').onclick=event=>{event.stopPropagation();setSidebarHelpOpen($('#sidebarHelpMenu').hidden)};$('#sidebarHelpSettings').onclick=()=>{setSidebarHelpOpen(false);openSettings('general-settings')};$('#sidebarHelpShortcuts').onclick=()=>{setSidebarHelpOpen(false);openSettings('keyboard-shortcuts')};$('#accountSettings').onclick=()=>openSettings('general-settings');$('#accountProfile').onclick=()=>openSettings('profile');$('#accountUsage').onclick=()=>openSettings('profile');$('#accountShortcuts').onclick=()=>openSettings('keyboard-shortcuts');for(const button of document.querySelectorAll('[data-settings-page]'))button.onclick=()=>setSettingsPage(button.dataset.settingsPage);$('#settingsAutoReviewToggle').onchange=event=>setPermissionVisibility('autoReview',event.currentTarget.checked);$('#settingsTaskNotifyToggle').onchange=event=>setTaskNotifyEnabled(event.currentTarget.checked);$('#settingsFullAccessToggle').onchange=event=>{if(!event.currentTarget.checked){setPermissionVisibility('fullAccess',false);return}event.currentTarget.checked=false;pendingFullAccessAction='enable';const dialog=$('#fullAccessDialog');if(!dialog.open)dialog.showModal()};$('#accountLogout').onclick=async()=>{if(!confirm('Log out?'))return;try{await rpc('account/logout');toggleAccountMenu(false);await loadAccount(true)}catch(error){toast(error.message)}};$('#settingsDialog').addEventListener('cancel',event=>{event.preventDefault();closeSettings()});
$('#languageSelect').value=i18n.preference;
$('#languageSelect').onchange=event=>i18n.setPreference(event.currentTarget.value);
function refreshLocalizedRuntime(){
  $('#languageSelect').value=i18n.preference;
  if(!state.active)$('#threadTitle').textContent=t('New task');
  if(!folderBrowse.selected)$('#folderSelection').textContent=t('No folder selected');
  if(state.account)renderAccount(state.account);else for(const id of ['accountName','accountMenuName','settingsAccountName'])$(`#${id}`).textContent=t('Settings');
  goalControls?.render();if(threadControls)renderThreads();syncPermissionControl();syncModelLabel();refreshComposerPlaceholder();renderContextUsage();renderChanges();
  syncComposerSubmitState();
  if(!$('#modelMenu').hidden)renderModelMenuMain();
  if($('#settingsDialog').open){const current=document.querySelector('[data-settings-page].active')?.dataset.settingsPage||settingsRoutePage()||'general-settings';setSettingsPage(current,{updateRoute:false});filterSettingsNavigation($('#settingsSearch').value)}
}
threadControls=createThreadControls({rpc,translate:t,titleOf,shortPath,formatTime:formatThreadTime,getActiveId:()=>state.active?.id,onOpen:id=>{projectControls?.closeMenu(false);if(mobileSidebarEnabled())setSidebarOpen(false);void openThread(id)},onUpdate:updateThreadMetadata,onRemove:removeThreadFromSidebar,onRestore:restoreThreadToProject,onRender:renderThreads,toast});
projectControls=createProjectControls({rpc,translate:t,projectKeyFor:sidebarProjectKey,projectName:sidebarProjectName,getThreads:()=>state.threads,onNew:projectKey=>{startNewTask({projectKey});if(mobileSidebarEnabled())setSidebarOpen(false)},onRemove:removeThreadFromSidebar,onRefresh:refresh=>{renderThreads();if(refresh){void refreshThreadList();threadControls.connected()}},onProjectEmpty:key=>{if(!state.active&&currentSidebarProjectKey()===key)startNewTask()},closeThreadMenu:()=>threadControls.closeMenu(false),toast});
goalControls=createGoalController({rpc,getThread:()=>state.active,ensureThread:ensureGoalThread,translate:t,onModeChange:active=>{state.goalMode=active;refreshComposerPlaceholder()}});
i18n.subscribe(refreshLocalizedRuntime);
refreshLocalizedRuntime();
$('#closeSidebar').onclick=()=>setSidebarOpen(false);$('#toggleSidePanel').onclick=()=>setSidePanelOpen($('#sidePanel').hidden);$('#toggleBottomPanel').onclick=()=>setBottomPanelOpen($('#bottomPanel').hidden);$('#closeBottomPanel').onclick=()=>setBottomPanelOpen(false);$('#toggleSidebar').onclick=()=>setSidebarOpen(mobileSidebarEnabled()?!$('#sidebar').classList.contains('mobile-open'):document.body.classList.contains('sidebar-hidden'));$('#closeSidePanel').onclick=()=>setSidePanelOpen(false);$('#closeSummaryPanel').onclick=()=>setSummaryPanelOpen(false);document.addEventListener('click',e=>{const target=e.target instanceof Element?e.target:null,image=target?.closest('[data-image-src]');if(image){e.preventDefault();openImageViewer(image.dataset.imageSrc,image.dataset.imageTitle||image.querySelector('img')?.alt||'Image',image.dataset.imagePath||'');return}if(target?.closest('a[data-file-download]'))return;const citation=target?.closest('a[data-file-reference]');if(!citation)return;e.preventDefault();dispatchEvent(new CustomEvent('codex-webui:file-reference',{detail:{path:citation.dataset.fileReference,lineStart:Number(citation.dataset.fileLineStart)||null,lineEnd:Number(citation.dataset.fileLineEnd)||null}}))});document.addEventListener('click',e=>{const path=e.composedPath();closeApprovalMenus(path);if(!path.includes($('#modelPicker')))closeModelMenu();if(!path.includes($('#permissionPicker')))closePermissionMenu();if(!path.includes($('#accountMenu'))&&!path.includes($('#accountButton')))toggleAccountMenu(false);if(!path.includes($('#sidebarSearchPanel'))&&!path.includes($('#sidebarSearchButton')))setSidebarSearchOpen(false);if(!path.includes($('#sidebarHelpMenu'))&&!path.includes($('#sidebarHelpButton')))setSidebarHelpOpen(false)});document.addEventListener('visibilitychange',()=>{if(document.visibilityState!=='visible')return;scheduleThreadListRefresh(0);scheduleActiveThreadSync(0)});addEventListener('keydown',e=>{if(state.initializing)return;if(e.target instanceof Element&&e.target.closest('.terminal-host'))return;if(e.key==='Escape'){if(e.isComposing||e.keyCode===229||e.repeat)return;if($('#imageViewer').open){e.preventDefault();closeImageViewer();return}if($('#folderDialog').open||$('#fullAccessDialog').open||$('#goalDialog').open||threadControls?.isRenaming())return;if(threadControls?.hasOpenMenu()){e.preventDefault();threadControls.closeMenu();return;}if(projectControls?.hasOpenMenu()){e.preventDefault();projectControls.closeMenu();return;}if(e.defaultPrevented)return;if(!$('#sidebarSearchPanel').hidden){e.preventDefault();setSidebarSearchOpen(false);return}if(!$('#sidebarHelpMenu').hidden){e.preventDefault();setSidebarHelpOpen(false);return}if($('#settingsDialog').open){e.preventDefault();closeSettings();return}const menuOpen=!$('#modelMenu').hidden||!$('#permissionMenu').hidden||!$('#accountMenu').hidden||!$('#goalMenu').hidden||Boolean(document.querySelector('.approval-menu:not([hidden])'));closeModelMenu();closePermissionMenu();closeApprovalMenus();toggleAccountMenu(false);if(menuOpen)return;if(document.body.classList.contains('side-panel-open'))setSidePanelOpen(false);else if(document.body.classList.contains('summary-panel-open'))setSummaryPanelOpen(false);else if(activeTurnId()){e.preventDefault();void interruptForSteering()}}if((e.metaKey||e.ctrlKey)&&e.key==='k'){e.preventDefault();startNewTask()}if((e.metaKey||e.ctrlKey)&&e.key==='b'){e.preventDefault();$('#toggleSidebar').click()}if((e.metaKey||e.ctrlKey)&&e.key==='j'){e.preventDefault();$('#toggleBottomPanel').click()}});addEventListener('resize',()=>{syncOverlayPanelMode();syncSidebarLayout();for(const terminalState of Object.values(terminalStates))requestAnimationFrame(()=>fitTerminal(terminalState))});
globalThis.__codexWebuiDebug={notify:onNotification,request:onServerRequest,state,browserState,navigateBrowser,renderChanges,renderAccount,renderHeader,refreshComposerPlaceholder,setProjectless,openImageViewer,openThread,loadInitial,startNewTask,setSidebarOpen,openSettings,closeSettings,settingsRoutePage,selectedPermission,permissionThreadPolicy,permissionTurnPolicy,setPermissionMode,setPermissionProfiles,setPermissionVisibility,renderPermissionMenu,filterAppModels,renderModels,syncTurnSnapshot,recordTurnReview,scrollOpenedThreadToBottom};
async function boot(){syncSidebarLayout();syncPermissionControl();try{state.config=await fetch('/api/config').then(r=>r.json())}catch{}if(threadRouteId())clearWorkspaceSelection();else restoreDraftWorkspace();refreshComposerPlaceholder();connect()}
composerAttachments=createAttachmentController({form:$('#composer'),prompt:$('#prompt'),picker:$('#attachmentPicker'),tray:$('#composerAttachmentTray'),button:document.querySelector('[data-composer-control="add"]'),translate:t,onChange:syncComposerSubmitState,onError:message=>toast(message,5000)});
boot();
