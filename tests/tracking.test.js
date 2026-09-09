'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const T=require('../lib/tracking-status');
const {createCarrierTracking}=require('../lib/carrier-tracking');
const N='6A12345678901';
const at='2026-09-07T12:00:00Z';
const old='2026-09-06T12:00:00Z';

const cases=[
 ['Livré','livre'],['Votre colis est livré.','livre'],['Votre colis a été livré','livre'],
 ['Distribué','livre'],['Livraison effectuée','livre'],['Livré - remis au gardien','livre'],
 ['Votre colis a été retiré','livre'],['Votre colis a été déposé dans votre boîte aux lettres.','livre'],
 ['En cours de livraison','en_transit'],['Livraison prévue demain','en_transit'],
 ['Votre colis est en transit pour vous être livré','en_transit'],
 ['Colis déposé en bureau de poste','en_transit'],['Remis au transporteur','en_transit'],
 ['Colis disponible au point relais','pret_retrait'],['Livré au point relais','pret_retrait'],
 ['En attente de retrait','pret_retrait'],['Livraison non effectuée','incident'],
 ['Not delivered','incident'],['Colis retourné à l’expéditeur','incident'],
 ['Livraison refusée','incident'],['Votre colis va bientôt nous être confié','en_attente'],
 ['En transit','en_transit'],['Texte non reconnu','inconnu']
];
for(const [label,expected] of cases)test(`libellé : ${label}`,()=>assert.equal(T.classify(label,'colissimo'),expected));

test('codes transporteurs documentés',()=>{
 for(const [carrier,code,status] of [
  ['colissimo','LIVCFM','livre'],['colissimo','AARBPR','pret_retrait'],
  ['colissimo','PCHTRI','en_transit'],['colissimo','PCHMQT','en_attente'],
  ['chronopost','TIMELINE_5','livre'],['ups','D','livre'],['ups','X','incident'],
  ['fedex','DL','livre'],['tnt','DL','livre'],['fedex','OD','en_transit']
 ])assert.equal(T.classify(code,carrier),status,`${carrier}/${code}`);
 assert.equal(T.classify('DL','colissimo'),'inconnu');
});
test('dates compactes et ISO, sans inventer une date absente',()=>{
 assert.equal(T.date('20260907'),Date.parse('2026-09-07T00:00:00'));
 assert.equal(T.date('20260907T114532'),Date.parse('2026-09-07T11:45:32'));
 assert.equal(T.date(null),null);
 assert.equal(T.event({label:'Livré'}).at,null);
});
test('dernier événement chronologique, pas le premier tableau',()=>{
 const n=T.normalize({carrier:'colissimo',number:N,events:[
  {at:old,label:'Livré'},{at,label:'Retour à l’expéditeur'}]});
 assert.equal(n.status,'incident');assert.equal(n.events[0].label,'Retour à l’expéditeur');
});
test('statut courant explicite prime sur un historique ancien',()=>{
 const n=T.normalize({carrier:'colissimo',number:N,status:'livre',events:[{at:old,label:'En transit'}]});
 assert.equal(n.status,'livre');
});
test('dernier événement inconnu ne ressuscite pas un ancien événement livré',()=>{
 const n=T.normalize({carrier:'colissimo',number:N,events:[{at:old,label:'Livré'},{at,label:'Événement non reconnu'}]});
 assert.equal(n.status,'inconnu');
});
test('fusion : statut transporteur livré conservé contre snapshot marketplace ancien',()=>{
 const live=T.fromCarrierResponse({status:'livre',statusAt:at},'colissimo',N,Date.parse(at));
 const market=T.normalize({carrier:'colissimo',number:N,status:'en_transit',statusSource:'marketplace'});
 assert.equal(T.merge(live,market).status,'livre');
 assert.equal(T.merge(market,live).status,'livre');
 assert.equal(T.merge(live,market).statusSource,'transporteur');
});
test('fusion : état inconnu ne remplace pas une livraison connue',()=>{
 const live=T.fromCarrierResponse({status:'livre'},'colissimo',N);
 const empty=T.fromCarrierResponse({status:'inconnu',events:[]},'colissimo',N);
 assert.equal(T.merge(live,empty).status,'livre');
});
test('fusion : nouveau suivi vérifié peut corriger un ancien état livré',()=>{
 const delivered=T.fromCarrierResponse({status:'livre',statusAt:old},'colissimo',N,Date.parse(old));
 const returned=T.fromCarrierResponse({status:'incident',statusAt:at},'colissimo',N,Date.parse(at));
 assert.equal(T.merge(delivered,returned).status,'incident');
});
test('fusion : aucun mélange des événements de deux numéros',()=>{
 const a=T.normalize({number:N,carrier:'colissimo',status:'livre',events:[{at:old,label:'Livré'}]});
 const b=T.normalize({number:'6A98765432109',carrier:'colissimo',status:'en_transit'});
 assert.equal(T.merge(a,b).number,b.number);
 assert.equal(T.merge(a,b).events.length,0);
});
function mockApi(payloads){
 const calls=[];
 const fetch=async(url,options={})=>{
  calls.push({url:String(url),options});
  const value=typeof payloads==='function'?payloads(String(url),options):payloads;
  if(value instanceof Error)throw value;
  return {ok:true,status:200,json:async()=>value};
 };
 return {fetch,calls};
}
test('La Poste : code LIVCFM et historique réel',async()=>{
 const {fetch,calls}=mockApi({returnCode:200,shipment:{idShip:N,isFinal:true,deliveryDate:at,
  event:[{date:old,status:'PCHTRI',label:'En transit'},{date:at,status:'LIVCFM',label:'Votre colis est livré.'}]}});
 const api=createCarrierTracking({fetch,env:{LAPOSTE_OKAPI_KEY:'FAUSSE-CLE-TEST'}});
 const n=await api.track('colissimo',N);
 assert.equal(n.status,'livre');assert.equal(n.statusSource,'transporteur');assert.ok(n.checkedAt);
 assert.equal(n.events[0].status,'livre');assert.equal(n.statusRaw,'Votre colis est livré.');
 assert.equal(calls[0].options.headers['X-Okapi-Key'],'FAUSSE-CLE-TEST');
});
test('La Poste : dernière étape de timeline validée',async()=>{
 const {fetch}=mockApi({shipment:{idShip:N,isFinal:true,timeline:[{id:5,status:true,date:at,shortLabel:'Votre colis a été retiré'}],event:[]}});
 const api=createCarrierTracking({fetch,env:{LAPOSTE_OKAPI_KEY:'FAUSSE-CLE-TEST'}});
 assert.equal((await api.track('chronopost',N)).status,'livre');
});
test('La Poste : isFinal seul ne prouve pas une livraison',async()=>{
 const {fetch}=mockApi({shipment:{idShip:N,isFinal:true,event:[{date:at,label:'Colis retourné à l’expéditeur'}]}});
 const api=createCarrierTracking({fetch,env:{LAPOSTE_OKAPI_KEY:'FAUSSE-CLE-TEST'}});
 assert.equal((await api.track('colissimo',N)).status,'incident');
});
test('UPS : currentStatus D prime sur les scans non ordonnés',async()=>{
 const num='1Z999AA10123456784';
 const {fetch}=mockApi(url=>url.includes('/oauth/token')?{access_token:'FAUX-TOKEN',expires_in:3600}:{trackResponse:{shipment:[{package:[{trackingNumber:num,currentStatus:{code:'D',description:'Delivered'},activity:[{date:'20260906',time:'120000',status:{code:'I',description:'In Transit'}},{date:'20260907',time:'114532',status:{code:'D',description:'Delivered'}}]}]}]}});
 const api=createCarrierTracking({fetch,env:{UPS_CLIENT_ID:'test',UPS_CLIENT_SECRET:'test'}});
 const n=await api.track('ups',num);
 assert.equal(n.status,'livre');assert.equal(n.events[0].at,Date.parse('2026-09-07T11:45:32'));
});
test('DHL : statusCode courant delivered, pas le premier événement',async()=>{
 const {fetch}=mockApi({shipments:[{id:N,status:{statusCode:'delivered',description:'Delivered',timestamp:at},events:[{timestamp:old,description:'In transit'}]}]});
 const api=createCarrierTracking({fetch,env:{DHL_API_KEY:'test'}});
 assert.equal((await api.track('dhl',N)).status,'livre');
});
test('FedEx : latestStatusDetail DL',async()=>{
 const {fetch}=mockApi(url=>url.includes('/oauth/token')?{access_token:'FAUX-TOKEN',expires_in:3600}:{output:{completeTrackResults:[{trackResults:[{trackingNumberInfo:{trackingNumber:N},latestStatusDetail:{code:'DL',description:'Delivered'},scanEvents:[{date:old,eventType:'IT',eventDescription:'In transit'}],dateAndTimes:[{type:'ACTUAL_DELIVERY',dateTime:at}]}]}]}});
 const api=createCarrierTracking({fetch,env:{FEDEX_CLIENT_ID:'test',FEDEX_CLIENT_SECRET:'test'}});
 assert.equal((await api.track('fedex',N)).status,'livre');
});
test('connecteur non configuré : erreur explicite sans appel réseau',async()=>{
 const {fetch,calls}=mockApi({});const api=createCarrierTracking({fetch,env:{TRACKING_PAGE_ENABLED:'0'}});
 await assert.rejects(api.track('dpd',N),e=>e.code==='TRACKING_NOT_CONFIGURED');
 await assert.rejects(api.track('dhl',N),e=>e.code==='TRACKING_NOT_CONFIGURED');
 assert.equal(calls.length,0);
});
test('erreur transporteur : aucun secret dans le message',async()=>{
 const fetch=async()=>({ok:false,status:401});
 const api=createCarrierTracking({fetch,env:{LAPOSTE_OKAPI_KEY:'SECRET-NE-PAS-AFFICHER'}});
 await assert.rejects(api.track('colissimo',N),e=>e.code==='TRACKING_AUTH_ERROR'&&!e.message.includes('SECRET-NE-PAS-AFFICHER'));
});
test('frontend : même normalisation et conservation du suivi vérifié',()=>{
 const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
 const code=html.slice(html.indexOf('function cleanTrackingText('),html.indexOf('function validGtinChecksumUi('));
 const context={TrackingStatus:T,Date,Math,URL,console};
 vm.createContext(context);vm.runInContext(code,context);
 const n=context.normalizeDisplayTracking({carrier:'colissimo',number:N,status:'livre',statusSource:'transporteur',checkedAt:Date.parse(at),events:[{at:old,label:'En transit'}]});
 assert.equal(n.status,'livre');assert.equal(n.statusSource,'transporteur');
 assert.equal(context.normalizeTrackStatusUi('Votre colis est livré.',[],'colissimo'),'livre');
});


test('API multi-colis : ne pas attribuer la livraison d’un autre numéro',async()=>{
 const requested='1Z999AA10123456784';
 const {fetch}=mockApi(url=>url.includes('/oauth/token')?{access_token:'FAUX-TOKEN'}:{trackResponse:{shipment:[{package:[{trackingNumber:'1Z999AA10123456785',currentStatus:{code:'D',description:'Delivered'}}]}]}});
 const api=createCarrierTracking({fetch,env:{UPS_CLIENT_ID:'test',UPS_CLIENT_SECRET:'test'}});
 await assert.rejects(api.track('ups',requested),e=>e.code==='TRACKING_NUMBER_MISMATCH');
});
test('La Poste : un numéro de réponse différent est refusé',async()=>{
 const {fetch}=mockApi({shipment:{idShip:'6A98765432109',event:[{date:at,status:'LIVCFM',label:'Livré'}]}});
 const api=createCarrierTracking({fetch,env:{LAPOSTE_OKAPI_KEY:'test'}});
 await assert.rejects(api.track('colissimo',N),e=>e.code==='TRACKING_NUMBER_MISMATCH');
});
test('DHL : sélectionner le bon colis parmi plusieurs',async()=>{
 const {fetch}=mockApi({shipments:[{id:'6A98765432109',status:{statusCode:'delivered'}},{id:N,status:{statusCode:'transit'}}]});
 const api=createCarrierTracking({fetch,env:{DHL_API_KEY:'test'}});
 assert.equal((await api.track('dhl',N)).status,'en_transit');
});
test('un statut conservé ne reçoit pas la date de vérification d’un autre état',()=>{
 const a=T.fromCarrierResponse({status:'livre',statusAt:at},'colissimo',N,Date.parse(at));
 const b=T.fromCarrierResponse({status:'inconnu'},'colissimo',N,Date.parse(at)+60000);
 assert.equal(T.merge(a,b).checkedAt,Date.parse(at));
});
test('un transporteur générique est reconnu depuis un numéro ou une URL',()=>{
 const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
 const code=html.slice(html.indexOf('function cleanTrackingText('),html.indexOf('function validGtinChecksumUi('));
 const context={TrackingStatus:T,Date,Math,URL,console};
 vm.createContext(context);vm.runInContext(code,context);
 assert.equal(context.normalizeDisplayTracking({carrier:'transporteur',number:'1Z999AA10123456784'}).carrier,'ups');
 assert.equal(context.normalizeDisplayTracking({carrier:'transporteur',number:N,url:'https://www.laposte.fr/outils/suivre-vos-envois?code='+N}).carrier,'colissimo');
});

test('rafraîchissement du tableau : cache et absence de boucle de rendu',async()=>{
 const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
 const normalizers=html.slice(html.indexOf('function cleanTrackingText('),html.indexOf('function validGtinChecksumUi('));
 const refresh=html.slice(html.indexOf('const TRACKING_LIVE_TTL='),html.indexOf('function renderTable(){',html.indexOf('const TRACKING_LIVE_TTL=')));
 const live=T.fromCarrierResponse({status:'livre',statusAt:at},'colissimo',N,Date.parse(at));
 let calls=0,renders=0;
 const context={TrackingStatus:T,Date,Math,URL,console,Map,Promise,JSON,
  CONFIG:{USE_DEMO_DATA:false},
  DataAPI:{fetchTrackingConfig:async()=>({carriers:{colissimo:{configured:true}}}),fetchTracking:async()=>{calls++;return live;}},
  renderTable:()=>{renders++;}};
 vm.createContext(context);vm.runInContext(normalizers+'\n'+refresh,context);
 const claim={tracking:{carrier:'colissimo',number:N,status:'en_transit'}};
 await context.refreshVisibleTrackingStatuses([claim]);
 assert.equal(claim.tracking.status,'livre');assert.equal(calls,1);assert.equal(renders,1);
 await context.refreshVisibleTrackingStatuses([claim]);
 assert.equal(calls,1);assert.equal(renders,1);
});
