'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {createCarrierTracking}=require('../lib/carrier-tracking');
const T=require('../lib/tracking-status');
const N='10654000122441';
const URL='https://trace.dpd.fr/trace-particuliers/'+N;
const PAGE=`<h2>Votre colis ${N}</h2><table><tr><th>Date</th><th>Heure</th><th>Les étapes de ma livraison</th><th>Localisation</th></tr><tr><td>08/09/2026</td><td>12:00</td><td>Votre colis est livré</td><td>Belfort</td></tr></table>`;
function response(body,status=200){return {ok:status>=200&&status<300,status,headers:{get:k=>k==='content-type'?'text/html':null},text:async()=>body};}
test('adaptateur DPD : page publique, sans clé API, et provenance exacte',async()=>{
 const calls=[];const fetch=async(url,options)=>{calls.push({url,options});return response(url.endsWith('/robots.txt')?'User-agent: *\nAllow: /':PAGE);};
 const service=createCarrierTracking({fetch,env:{TRACKING_PAGE_ENABLED:'1'}});
 assert.equal(service.apiConfigured('dpd'),false);assert.equal(service.configured('dpd'),true);
 const result=await service.track('dpd',N,{url:URL});
 assert.equal(result.status,'livre');assert.equal(result.statusMethod,'page');assert.equal(result.sourceUrl,URL);
 assert.ok(calls.every(c=>!c.options.headers.Authorization&&!c.options.headers.Cookie));
});
test('adaptateur : une page indisponible ne devient pas un statut livré',async()=>{
 const service=createCarrierTracking({fetch:async()=>response('',403),env:{TRACKING_PAGE_ENABLED:'1'}});
 await assert.rejects(service.track('dpd',N),e=>e.code==='TRACKING_ACCESS_REQUIRED');
});
test('adaptateur : désactivation de la lecture HTML ne désactive pas les API officielles',()=>{
 const service=createCarrierTracking({fetch:async()=>{throw Error('aucun appel attendu');},env:{TRACKING_PAGE_ENABLED:'0',LAPOSTE_OKAPI_KEY:'test'}});
 assert.equal(service.configured('dpd'),false);assert.equal(service.configured('colissimo'),true);
});
test('cache serveur : échec conservé, nouvelle URL et rafraîchissement forcé',async()=>{
 const code=fs.readFileSync(path.join(__dirname,'../proxy-exemple.js'),'utf8');
 const start=code.indexOf('const trackingCache = new Map();'),end=code.indexOf('/* =====================================================================',start);
 const calls=[];let clock=1000000;
 const service={pageTracking:{configured:()=>true,validatePageUrl:(url)=>url},track:async(c,n,options)=>{calls.push(options);if(calls.length===1)throw Object.assign(Error('Page indisponible'),{code:'TRACKING_PAGE_UNSUPPORTED',statusCode:503});return T.fromCarrierResponse({status:'livre',statusMethod:'page',sourceUrl:options.url},c,n,clock);}};
 const context={Map,Date:{now:()=>clock},TrackingStatus:T,carrierTracking:service,Promise};
 vm.createContext(context);vm.runInContext(code.slice(start,end),context);
 const get=(options={})=>context.getCarrierTracking('dpd',N,options);
 await assert.rejects(get(),e=>e.code==='TRACKING_PAGE_UNSUPPORTED');
 await assert.rejects(get(),e=>e.code==='TRACKING_PAGE_UNSUPPORTED');assert.equal(calls.length,1);
 const good=await get({url:URL});assert.equal(good.status,'livre');assert.equal(calls.length,2);
 clock+=1000;const old=await get({force:true});assert.equal(old.status,'livre');assert.equal(calls.length,2);
 clock+=31000;service.track=async()=>{throw Object.assign(Error('Erreur temporaire'),{code:'TRACKING_UNAVAILABLE',statusCode:503});};
 const stale=await get({force:true});assert.equal(stale.status,'livre');assert.equal(stale.verificationError,'Erreur temporaire');
 assert.equal(stale.checkedAt,good.checkedAt);
});
test('normalisation : nouveau suivi réel corrige un ancien statut et conserve un échec',()=>{
 const market=T.normalize({number:N,carrier:'dpd',status:'en_transit',statusSource:'marketplace'});
 const live=T.fromCarrierResponse({status:'livre',statusMethod:'page',sourceUrl:URL},'dpd',N,Date.parse('2026-09-08T12:00:00Z'));
 const result=T.merge(market,live);
 assert.equal(result.status,'livre');assert.equal(result.statusSource,'transporteur');assert.equal(result.statusMethod,'page');
 const failed=T.merge(result,{...result,verificationError:'Suivi temporairement inaccessible',verificationAt:Date.now()});
 assert.equal(failed.status,'livre');assert.equal(failed.verificationError,'Suivi temporairement inaccessible');
});
