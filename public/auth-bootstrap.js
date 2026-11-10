import { codexInterfaceMark } from './codex-brand.js';
import { createDomI18n, createI18n } from './i18n.js';
import { fetchJson } from './fetch-json.js';

const $=selector=>document.querySelector(selector);
const i18n=globalThis.__codexWebuiI18n||createI18n();
globalThis.__codexWebuiI18n=i18n;
globalThis.__codexWebuiDomI18n=globalThis.__codexWebuiDomI18n||createDomI18n(i18n);
const t=message=>i18n.t(message);
const app=$('#app'),screen=$('#startupScreen');
let startupTimer;
const startup={
  begin(){
    if(!app.hasAttribute('data-loading'))return;
    clearTimeout(startupTimer);screen.hidden=false;screen.setAttribute('aria-busy','true');$('#startupError').hidden=true;
    startupTimer=setTimeout(()=>startup.fail(new Error(t('Connecting is taking longer than expected.'))),20_000);
  },
  pause(){clearTimeout(startupTimer);screen.hidden=true},
  fail(reason,retry=()=>location.reload()){
    if(!app.hasAttribute('data-loading'))return;
    clearTimeout(startupTimer);screen.hidden=false;screen.setAttribute('aria-busy','false');$('#startupErrorDetail').textContent=reason?.message||String(reason);$('#startupError').hidden=false;
    $('#startupRetry').onclick=()=>{startup.begin();retry()};
  },
  finish(){
    clearTimeout(startupTimer);screen.hidden=true;$('#startupRetry').onclick=null;
    app.removeAttribute('data-loading');app.removeAttribute('aria-busy');app.removeAttribute('aria-hidden');app.inert=false;
  },
};
globalThis.__codexWebuiStartup=startup;
$('#startupCodexMark').innerHTML=codexInterfaceMark('empty-codex-mark');

async function loadApp(){
  for(const href of ['/vendor/katex/katex.min.css','/vendor/xterm/xterm.css']){
    if(document.querySelector(`link[href="${href}"]`))continue;
    const link=document.createElement('link');link.rel='stylesheet';link.href=href;document.head.append(link);
  }
  await import('/app.bundle.js');
}

async function start(){
  startup.begin();
  let status;
  try{
    status=await fetchJson('/api/auth/status');
  }catch(reason){console.error('[codex-webui] authentication status failed',reason);startup.fail(reason);return}
  if(status.authenticated||(!status.setupRequired&&!status.passwordRequired)){await loadApp();return}
  const gate=$('#passwordGate'),input=$('#passwordInput'),confirmInput=$('#passwordConfirmInput'),form=$('#passwordLoginForm'),button=$('#passwordLoginButton'),error=$('#passwordError'),title=$('#passwordTitle');
  let mode=status.setupRequired?'setup':'login';
  $('#passwordCodexMark').innerHTML=codexInterfaceMark('password-codex-mark');
  const configure=()=>{
    const setup=mode==='setup';
    title.textContent=t(setup?'Set a LAN password':'Log in');
    gate.setAttribute('aria-label',t(setup?'Codex WebUI password setup':'Codex WebUI login'));
    input.placeholder=t(setup?'New password':'Password');
    input.autocomplete=setup?'new-password':'current-password';
    input.minLength=setup?12:0;
    input.maxLength=256;
    confirmInput.hidden=!setup;confirmInput.required=setup;confirmInput.value='';
    button.textContent=t(setup?'Set password':'Log in');
  };
  configure();startup.pause();gate.hidden=false;requestAnimationFrame(()=>input.focus());
  form.onsubmit=async event=>{
    event.preventDefault();error.hidden=true;
    if(mode==='setup'&&input.value.length<12){error.textContent=t('Password must be at least 12 characters');error.hidden=false;input.focus();return}
    if(mode==='setup'&&input.value!==confirmInput.value){error.textContent=t('Passwords do not match');error.hidden=false;confirmInput.select();return}
    const endpoint=mode==='setup'?'/api/auth/setup':'/api/auth/login';
    button.disabled=true;button.textContent=t(mode==='setup'?'Setting password…':'Logging in…');
    try{
      await fetchJson(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:input.value})});
      gate.hidden=true;startup.begin();input.value='';confirmInput.value='';
      await loadApp();
    }catch(reason){if(gate.hidden){startup.fail(reason);return}if(mode==='setup'&&reason.status===409){mode='login';input.value='';configure();reason=new Error(t('A password was already set. Log in to continue.'))}error.textContent=reason instanceof Error?reason.message:String(reason);error.hidden=false;input.select()}
    finally{button.disabled=false;button.textContent=t(mode==='setup'?'Set password':'Log in')}
  };
}

start().catch(error=>{console.error('[codex-webui] authentication bootstrap failed',error);startup.fail(error)});
