'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const T=require('../lib/tracking-status');
const {createCarrierTracking}=require('../lib/carrier-tracking');
const {parseChronopostResponse,trackChronopostPublic,ENDPOINT}=require('../lib/tracking-chronopost');
const {normalizeLaposteResponse}=require('../lib/tracking-laposte');
const {parseTrackingXml}=require('../lib/tracking-xml');
const {parseTrackingPage,createPageTracking,canonicalUrl,validatePageUrl}=require('../lib/tracking-pages');
const C='XY123456789FR',R='FGRC45BKLM',N='CV250112233445';
const date1='2026-09-06T10:00:00+02:00',date2='2026-09-08T10:00:00+02:00';
const response=(body,status=200,type='application/xml')=>({ok:status>=200&&status<300,status,headers:{get:k=>k==='content-type'?type:null},text:async()=>body});
const chronoXml=(events,number=C,code='0')=>`<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><ns2:trackSkybillV2Response xmlns:ns2="http://cxf.tracking.soap.chronopost.fr"><return><errorCode>${code}</errorCode><skybillNumber>${number}</skybillNumber>${events.map(e=>`<listEvents><eventDate>${e.at}</eventDate><eventCode>${e.code||'X'}</eventCode><eventLabel>${e.label}</eventLabel></listEvents>`).join('')}</return></ns2:trackSkybillV2Response></soap:Body></soap:Envelope>`;
const chronoDelivered=chronoXml([{at:date1,label:'Colis pris en charge'},{at:date2,label:'Livraison effectuée'}]);
function ccvPage(status,reference=R,extra=''){
 return `<html><main><h1>Votre commande : ${reference}</h1><section class="tracking-parcel"><h2>Statut de livraison</h2><p>${status}</p></section></main><section class="faq"><h3>Pourquoi mon colis est livré ?</h3><p>Une réponse d’aide sans statut.</p></section>${extra}</html>`;
}
const ccv=(html,ref=R)=>parseTrackingPage(html,{carrier:'chezvous',number:ref,url:canonicalUrl('chezvous',ref)});
test('Chronopost : webservice public sans compte, URL fixe et aucun secret',async()=>{
 const calls=[];const fetch=async(url,options)=>{calls.push({url,options});return response(chronoDelivered);};
 const svc=createCarrierTracking({fetch,env:{TRACKING_PAGE_ENABLED:'0'}});
 assert.equal(svc.configured('chronopost'),true);assert.equal(svc.apiConfigured('chronopost'),false);assert.equal(svc.publicApiConfigured('chronopost'),true);
 const r=await svc.track('chronopost',C);
 assert.equal(r.status,'livre');assert.equal(r.statusSource,'transporteur');assert.equal(r.statusMethod,'api');
 assert.equal(r.events.length,2);assert.equal(r.events[0].status,'livre');
 assert.equal(calls.length,1);assert.equal(new URL(calls[0].url).origin,'https://ws.chronopost.fr');
 assert.equal(new URL(calls[0].url).pathname,new URL(ENDPOINT).pathname);
 assert.equal(new URL(calls[0].url).searchParams.get('skybillNumber'),C);
 assert.equal(calls[0].options.redirect,'error');assert.ok(!calls[0].options.headers.Authorization&&!calls[0].options.headers.Cookie);
});
test('Chronopost : API La Poste prioritaire et repli public si elle échoue',async()=>{
 const calls=[];const fetch=async(url)=>{calls.push(url);return url.includes('api.laposte.fr')?response('{}',503):response(chronoDelivered);};
 const svc=createCarrierTracking({fetch,env:{LAPOSTE_OKAPI_KEY:'TEST_KEY',TRACKING_PAGE_ENABLED:'0'}});
 assert.equal((await svc.track('chronopost',C)).status,'livre');assert.equal(calls.length,2);
 const configured=createCarrierTracking({fetch,env:{LAPOSTE_OKAPI_KEY:'TEST_KEY',CHRONOPOST_PUBLIC_TRACKING:'0',TRACKING_PAGE_ENABLED:'0'}});
 assert.equal(configured.publicApiConfigured('chronopost'),false);assert.equal(configured.apiConfigured('chronopost'),true);
});
test('Chronopost : structure SOAP ListEvents/events et contrôle du colis',()=>{
 const xml=`<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><trackSkybillV2Response><return><errorCode>0</errorCode><listEvents><skybillNumber>${C}</skybillNumber><events><eventDate>${date1}</eventDate><eventLabel>Colis pris en charge</eventLabel></events><events><eventDate>${date2}</eventDate><eventLabel>Votre colis est livré</eventLabel></events></listEvents></return></trackSkybillV2Response></soap:Body></soap:Envelope>`;
 const r=parseChronopostResponse(xml,C);
 assert.equal(r.status,'livre');assert.equal(r.events.length,2);
 assert.throws(()=>parseChronopostResponse(xml.replace(`<skybillNumber>${C}</skybillNumber>`, '<skybillNumber>XY987654321FR</skybillNumber>'),C),e=>e.code==='TRACKING_NUMBER_MISMATCH');
});
test('Chronopost : dernier événement retour ne devient pas livré',()=>{
 const r=parseChronopostResponse(chronoXml([{at:date1,label:'Livraison effectuée'},{at:date2,label:'Retour à l’expéditeur'}]),C);
 assert.equal(r.status,'incident');assert.equal(r.events[0].status,'incident');
});
test('Chronopost : numéro différent, code erreur et XML hostile refusés',async()=>{
 assert.throws(()=>parseChronopostResponse(chronoXml([{at:date2,label:'Livré'}],'XY987654321FR'),C),e=>e.code==='TRACKING_NUMBER_MISMATCH');
 assert.throws(()=>parseChronopostResponse(chronoXml([],C,'42'),C),e=>e.code==='TRACKING_UPSTREAM_ERROR');
 assert.throws(()=>parseChronopostResponse('<!DOCTYPE x [<!ENTITY a SYSTEM "file:///etc/passwd">]><x>&a;</x>',C),e=>e.code==='TRACKING_RESPONSE_INVALID');
 assert.throws(()=>parseTrackingXml('<a><b></a>'));
 assert.throws(()=>parseTrackingXml('<a>&#x110000;</a>'));
 assert.throws(()=>parseTrackingXml('<a>'+ '<b>'.repeat(65) +'</b>'.repeat(65)+'</a>'));
 await assert.rejects(trackChronopostPublic(async()=>response('',403),C),e=>e.code==='TRACKING_ACCESS_REQUIRED');
});
test('La Poste v2 : vrai schéma event/timeline sans shipment.status',()=>{
 const sh={idShip:C,event:[{date:date1,code:'ET2',label:'En cours d’acheminement'}],timeline:[{id:5,status:true,type:1,date:date2,shortLabel:'Votre colis est livré'}]};
 const r=normalizeLaposteResponse({returnCode:200,shipment:sh},C,'chronopost');
 assert.equal(r.status,'livre');assert.equal(r.statusAt,Date.parse(date2));
 assert.equal(normalizeLaposteResponse({returnCode:200,shipment:{idShip:C,isFinal:true,deliveryDate:date2,event:[{date:date1,label:'En cours d’acheminement'}]}},C,'chronopost').status,'livre');
 assert.equal(normalizeLaposteResponse({returnCode:200,shipment:{idShip:C,isFinal:true,deliveryDate:date2,event:[{date:'2026-09-09T10:00:00+02:00',label:'Retour à l’expéditeur'}]}},C,'chronopost').status,'incident');
});
test('La Poste : statut final seul, étape inactive ou échec ne prouvent pas une remise',()=>{
 assert.equal(normalizeLaposteResponse({shipment:{idShip:C,isFinal:true,event:[{date:date1,label:'En cours d’acheminement'}],timeline:[{id:5,status:false,type:1,shortLabel:'Livré'}]}},C,'chronopost').status,'en_transit');
 assert.throws(()=>normalizeLaposteResponse({shipment:{idShip:'XY987654321FR',event:[{date:date2,label:'Livré'}]}},C),e=>e.code==='TRACKING_NUMBER_MISMATCH');
});
test('C Chez Vous : références officielles avec lettres, chiffres et séparateurs',()=>{
 for(const ref of [R,'4TZKO156790--59600','BBC_269148','FGRCABCDEF']){
  assert.equal(T.validNumber(ref,'chezvous'),true);
  const url=canonicalUrl('chezvous',ref);assert.equal(T.chezvousReferenceFromUrl(url),ref);
  assert.equal(validatePageUrl(url,'chezvous',ref),url);
  assert.equal(T.normalize({carrier:'chezvous',number:ref,status:'inconnu'}).number,ref);
 }
 assert.equal(T.validNumber('FGRCABCDEF','chronopost'),false);
 assert.equal(T.chezvousReferenceFromUrl('https://www.cchezvous.fr.evil.test/suivi-colis/'+R),'');
 assert.equal(T.chezvousReferenceFromUrl('https://www.cchezvous.fr/suivi-colis/'+R+'?url=http://localhost'),'');
});
test('C Chez Vous : panneau de statut de la bonne commande',()=>{
 assert.equal(ccv(ccvPage('Votre commande est livrée')).status,'livre');
 assert.equal(ccv(ccvPage('Livraison terminée')).status,'livre');
 assert.equal(ccv(ccvPage('En cours de livraison')).status,'en_transit');
 assert.equal(ccv(ccvPage('Prêt à retirer en point relais')).status,'pret_retrait');
 assert.equal(ccv(ccvPage('Retour à l’expéditeur')).status,'incident');
 assert.throws(()=>ccv(ccvPage('Livré','FGRCABCDEF')),e=>e.code==='TRACKING_NUMBER_MISMATCH');
});
test('C Chez Vous : FAQ, barre décorative et état de commande ne prouvent rien',()=>{
 assert.throws(()=>ccv(ccvPage('',R).replace('<h2>Statut de livraison</h2><p></p>','<div>En transit · Livré</div>')),e=>e.code==='TRACKING_PAGE_UNSUPPORTED');
 assert.throws(()=>ccv(`<h1>Votre commande : ${R}</h1><section class="faq"><h2>Statut de livraison</h2><p>Livré</p></section>`),e=>e.code==='TRACKING_PAGE_UNSUPPORTED');
 const json=JSON.stringify({orderNumber:R,status:'DELIVERED',paymentStatus:'PAID'});
 assert.throws(()=>ccv(`<script type="application/json">${json}</script>`),e=>e.code==='TRACKING_PAGE_UNSUPPORTED');
});
test('C Chez Vous : JSON de livraison lié à la commande, pas au paiement',()=>{
 const data={orders:[{orderNumber:R,status:'PAID',delivery:{status:'Livraison effectuée',statusAt:date2}},{orderNumber:'FGRCABCDEF',delivery:{status:'En transit'}}]};
 const html=`<script type="application/json">${JSON.stringify(data)}</script>`;
 assert.equal(ccv(html).status,'livre');
 assert.equal(ccv(html,'FGRCABCDEF').status,'en_transit');
 assert.throws(()=>ccv(html,'FGRCABCXYZ'),e=>e.code==='TRACKING_PAGE_UNSUPPORTED');
});
test('C Chez Vous : la référence du lien est séparée du numéro de colis',async()=>{
 const calls=[];const fetch=async(url,options)=>{calls.push(url);return response(url.endsWith('/robots.txt')?'User-agent: *\nAllow: /':ccvPage('Livraison effectuée'),200,'text/html');};
 const svc=createCarrierTracking({fetch,env:{TRACKING_PAGE_INTERVAL_MS:'1000'}});
 const url=canonicalUrl('chezvous',R);
 const result=await svc.track('chezvous',N,{url,reference:R});
 assert.equal(result.number,N);assert.equal(result.orderReference,R);assert.equal(result.status,'livre');
 assert.ok(calls.some(u=>u===url));
 await assert.rejects(svc.track('chezvous',N,{url,reference:'FGRCABCDEF'}),e=>e.code==='TRACKING_NUMBER_MISMATCH');
});
test('C Chez Vous : fusion n’attribue pas un état à une autre référence',()=>{
 const a=T.normalize({carrier:'chezvous',number:N,orderReference:R,status:'livre',statusSource:'transporteur'});
 const b=T.normalize({carrier:'chezvous',number:N,orderReference:'FGRCABCDEF',status:'en_transit',statusSource:'marketplace'});
 assert.equal(T.merge(a,b).status,'en_transit');
 assert.equal(T.merge(a,b).orderReference,'FGRCABCDEF');
});
test('Frontend : conserve la référence C Chez Vous et son lien de suivi',()=>{
 const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
 const context={TrackingStatus:T,Date,Math,URL,console,Map,Promise,JSON};vm.createContext(context);
 vm.runInContext(html.slice(html.indexOf('function cleanTrackingText('),html.indexOf('function validGtinChecksumUi(')),context);
 const t=context.normalizeDisplayTracking({carrier:'chezvous',number:N,url:canonicalUrl('chezvous',R),status:'inconnu'});
 assert.equal(t.number,N);assert.equal(t.orderReference,R);
 assert.equal(context.trackingPageUrlUi(t),canonicalUrl('chezvous',R));
 assert.equal(context.normalizeDisplayTracking({carrier:'chezvous',number:'FGRCABCDEF',status:'inconnu'}).number,'FGRCABCDEF');
});
