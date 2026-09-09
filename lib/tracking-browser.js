'use strict';

// Navigateur facultatif : protocole Chrome DevTools sur un pipe local.
// Aucun service externe, aucune dépendance npm ni contournement anti-bot.
// Chrome doit être installé sur le serveur et pouvoir démarrer AVEC sandbox.
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawn}=require('node:child_process');

function failure(message,code='TRACKING_BROWSER_UNAVAILABLE',statusCode=503){return Object.assign(new Error(message),{code,statusCode});}
class DevToolsPipe {
  constructor(child){
    this.child=child;this.next=1;this.pending=new Map();this.handlers=new Map();this.buffer=Buffer.alloc(0);this.closed=false;
    child.stdio[4].on('data',chunk=>this.receive(chunk));
    child.stdio[4].on('error',()=>this.close());
    child.on('error',()=>this.close());child.on('exit',()=>this.close());
  }
  receive(chunk){
    this.buffer=Buffer.concat([this.buffer,chunk]);
    if(this.buffer.length>8*1024*1024){this.close();return;}
    let idx;
    while((idx=this.buffer.indexOf(0))>=0){
      const raw=this.buffer.subarray(0,idx).toString('utf8');this.buffer=this.buffer.subarray(idx+1);
      let msg;try{msg=JSON.parse(raw);}catch{continue;}
      if(msg.id){const p=this.pending.get(msg.id);if(!p)continue;this.pending.delete(msg.id);clearTimeout(p.timer);msg.error?p.reject(failure('Erreur du navigateur lors de la lecture.')):p.resolve(msg.result||{});}
      else if(msg.method){const handler=this.handlers.get(msg.method);if(handler)Promise.resolve().then(()=>handler(msg.params||{},msg.sessionId)).catch(()=>{});}
    }
  }
  send(method,params={},sessionId){
    if(this.closed)return Promise.reject(failure('Navigateur fermé.'));
    const id=this.next++,message={id,method,params,...(sessionId?{sessionId}:{})};
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(failure('Délai du navigateur dépassé.','TRACKING_TIMEOUT',504));},15000);
      this.pending.set(id,{resolve,reject,timer});
      this.child.stdio[3].write(JSON.stringify(message)+'\0',e=>{if(e){clearTimeout(timer);this.pending.delete(id);reject(failure('Communication navigateur impossible.'));}});
    });
  }
  on(method,handler){this.handlers.set(method,handler);}
  close(){if(this.closed)return;this.closed=true;for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(failure('Navigateur fermé.'));}this.pending.clear();}
}
function browserExecutable(env=process.env){
  const configured=String(env.TRACKING_CHROME_PATH||'').trim();
  if(!configured)return '';
  try{fs.accessSync(configured,fs.constants.X_OK);return configured;}catch{return '';}
}
function createBrowserRenderer({env=process.env,allowRequest,parseResult}={}){
  if(typeof allowRequest!=='function'||typeof parseResult!=='function')throw new TypeError('Contrôles navigateur requis');
  const executable=browserExecutable(env);
  async function render(url,context,{permitted:checkPermission=async()=>{}}={}){
    if(!executable)throw failure('Navigateur Chromium non configuré sur le serveur.');
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sav-tracking-'));
    let child=null,pipe=null;
    const timeout=Math.max(5000,Math.min(30000,Number(env.TRACKING_PAGE_BROWSER_TIMEOUT_MS)||18000));
    let deadlineTimer;
    async function work(){
      child=spawn(executable,[
        '--headless=new','--remote-debugging-pipe',`--user-data-dir=${dir}`,
        '--no-first-run','--no-default-browser-check','--disable-extensions',
        '--disable-background-networking','--disable-component-update','--disable-sync',
        '--disable-default-apps','--disable-dev-shm-usage','--no-proxy-server',
        '--disable-features=Translate,MediaRouter','--window-size=1280,900','about:blank'
      ],{stdio:['ignore','ignore','ignore','pipe','pipe'],detached:process.platform!=='win32',env:{...process.env,HOME:os.homedir()}});
      pipe=new DevToolsPipe(child);
      const {targetId}=await pipe.send('Target.createTarget',{url:'about:blank'});
      const {sessionId}=await pipe.send('Target.attachToTarget',{targetId,flatten:true});
      const send=(method,params={})=>pipe.send(method,params,sessionId);
      let blocked=false;
      pipe.on('Fetch.requestPaused',async p=>{
        const request=p.request||{},method=(request.method||'GET').toUpperCase();
        let permitted=false;
        try{permitted=allowRequest(request.url,p.resourceType||'Other',method,context);if(permitted)await checkPermission(request.url);}catch{permitted=false;}
        // Le navigateur ne fait aucune opération d'écriture sur les sites.
        if(!permitted||!['GET','HEAD'].includes(method)){blocked=true;await send('Fetch.failRequest',{requestId:p.requestId,errorReason:'BlockedByClient'});return;}
        await send('Fetch.continueRequest',{requestId:p.requestId});
      });
      await send('Page.enable');await send('Runtime.enable');
      await send('Network.enable');await send('Network.setBypassServiceWorker',{bypass:true});
      await send('Network.setCacheDisabled',{cacheDisabled:true});
      await send('Fetch.enable',{patterns:[{urlPattern:'*',requestStage:'Request'}]});
      const nav=await send('Page.navigate',{url});if(nav.errorText)throw failure('Navigation impossible : '+nav.errorText);
      const until=Date.now()+timeout;
      let lastError=null;
      while(Date.now()<until){
        const result=await send('Runtime.evaluate',{expression:'({html:document.documentElement.outerHTML,url:location.href})',returnByValue:true});
        const snapshot=result.result?.value;
        if(snapshot?.html&&snapshot?.url){
          if(snapshot.url==='about:blank'){await new Promise(r=>setTimeout(r,150));continue;}
          if(!allowRequest(snapshot.url,'Document','GET',context))throw failure('Navigation vers une page non autorisée.','TRACKING_URL_NOT_ALLOWED',400);
          try{return parseResult(snapshot.html,{...context,url:snapshot.url});}
          catch(e){lastError=e;if(['TRACKING_AMBIGUOUS','TRACKING_ACCESS_REQUIRED','TRACKING_URL_NOT_ALLOWED'].includes(e.code))throw e;}
        }
        await new Promise(r=>setTimeout(r,650));
      }
      if(blocked&&(!lastError||lastError.code==='TRACKING_PAGE_UNSUPPORTED'))throw failure('La page nécessite des ressources ou requêtes non autorisées.','TRACKING_PAGE_UNSUPPORTED');
      throw lastError||failure('Aucun statut exploitable après le rendu.','TRACKING_PAGE_UNSUPPORTED');
    }
    try{
      return await Promise.race([work(),new Promise((_,reject)=>{deadlineTimer=setTimeout(()=>reject(failure('Délai de rendu dépassé.','TRACKING_TIMEOUT',504)),timeout+2500);})]);
    }finally{
      clearTimeout(deadlineTimer);pipe?.close();
      if(child?.pid){try{if(process.platform!=='win32')process.kill(-child.pid,'SIGKILL');else child.kill('SIGKILL');}catch{try{child.kill('SIGKILL');}catch{}}}
      await fs.promises.rm(dir,{recursive:true,force:true}).catch(()=>{});
    }
  }
  return {render,configured:()=>Boolean(executable)};
}
module.exports={createBrowserRenderer,browserExecutable};
