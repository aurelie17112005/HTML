'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const T=require('../lib/tracking-status');
const N='6A12345678901';
const source=fs.readFileSync(path.join(__dirname,'../proxy-exemple.js'),'utf8');
const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
function functionSource(text,name){
 const start=text.search(new RegExp('^function '+name+'\\(', 'm'));
 assert.ok(start>=0,'Fonction absente : '+name);
 const end=text.indexOf('\n}',start);
 assert.ok(end>=0,'Fin absente : '+name);
 return text.slice(start,end+2);
}
function adapterContext(){
 const names=['scalarValue','scalarFirst','inferCarrierFromTrackingUrl','isLikelyTrackingUrl','safeTrackingUrl','normalizeCarrierCode','looksLikeTrackingNumber','firstDeepValue','collectDeepArrays','normalizeTracking','mergeTrackingInfo','normalizeOrderTracking'];
 const context={TrackingStatus:T,Date,Math,URL,console,Set,Map,
  cleanText:v=>v==null?'':String(v).trim(),
  foldStatusText:v=>String(v??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase(),
  normalizeTrackingEvent:e=>T.event(e)};
 vm.createContext(context);
 vm.runInContext(names.map(n=>functionSource(source,n)).join('\n'),context);
 return context;
}
const adapter=adapterContext();
test('régression : état CLOSED de réclamation ne masque pas delivery_status DELIVERED',()=>{
 const t=adapter.normalizeOrderTracking({status:'CLOSED',tracking_number:N,shipping_carrier:'DPD',delivery_status:'DELIVERED'});
 assert.equal(t.status,'livre');assert.equal(t.statusSource,'marketplace');
});
test('régression : statut de commande SHIPPED ne masque pas un statut de livraison',()=>{
 const t=adapter.normalizeOrderTracking({status:'SHIPPED',shipping_tracking_number:N,shipping_carrier:'GLS',delivery_status:'DELIVERED'});
 assert.equal(t.status,'livre');
});
test('régression : variante camelCase de shippingStatus',()=>{
 const t=adapter.normalizeOrderTracking({status:'PAID',shippingTrackingNumber:N,shippingCarrier:'DPD',shippingStatus:'Livré'});
 assert.equal(t.status,'livre');
});
test('régression : état de commande seul ne prouve pas une livraison',()=>{
 const t=adapter.normalizeOrderTracking({status:'DELIVERED',tracking_number:N,shipping_carrier:'DPD'});
 assert.equal(t.status,'inconnu');assert.notEqual(t.statusSource,'transporteur');
});
test('régression : expédition de commande reste identifiable comme telle',()=>{
 const t=adapter.normalizeOrderTracking({status:'SHIPPED',tracking_number:N,shipping_carrier:'DPD'});
 assert.equal(t.status,'en_transit');assert.equal(t.statusSource,'commande');
});
test('régression : paiement et clôture de réclamation ne sont pas des états de livraison',()=>{
 for(const status of ['PAID','CLOSED','RESOLVED']){
  const t=adapter.normalizeOrderTracking({status,tracking_number:N,shipping_carrier:'DPD'});
  assert.equal(t.status,'inconnu',status);
 }
});
test('régression : objet de statut avec code inconnu et libellé livré',()=>{
 const t=adapter.normalizeOrderTracking({shipping:{trackingNumber:N,carrier:'GLS',status:{code:'UNKNOWN_CODE',label:'Delivered'}}});
 assert.equal(t.status,'livre');
});
test('régression : statut brut connu conservé lorsque status vaut inconnu',()=>{
 const t=T.normalize({number:N,carrier:'dpd',status:'inconnu',statusRaw:'Votre colis est livré.'});
 assert.equal(t.status,'livre');assert.equal(t.statusRaw,'Votre colis est livré.');
});
test('régression : code inconnu conservé sans inventer de livraison',()=>{
 const t=T.normalize({number:N,carrier:'dpd',status:'inconnu',statusRaw:'ETAT_ABC'});
 assert.equal(t.status,'inconnu');assert.equal(t.statusRaw,'ETAT_ABC');
});
test('régression : dernier événement daté prime sur un ancien événement livré',()=>{
 const t=adapter.normalizeOrderTracking({shipping:{trackingNumber:N,carrier:'GLS',events:[
  {at:'2026-09-01T12:00:00Z',label:'Delivered'},
  {at:'2026-09-07T12:00:00Z',label:'Returned to sender'}
 ]}});
 assert.equal(t.status,'incident');
});
test('régression : fusion conserve un statut connu et n’invente pas un autre colis',()=>{
 const known=T.normalize({number:N,carrier:'dpd',status:'livre',statusSource:'marketplace'});
 const empty=T.normalize({number:N,carrier:'dpd',status:'inconnu'});
 assert.equal(T.merge(known,empty).status,'livre');
 assert.equal(T.merge(known,{number:'6A98765432109',carrier:'dpd',status:'en_transit'}).number,'6A98765432109');
});
function uiContext(){
 const context={TrackingStatus:T,Date,Math,URL,console,Map,Promise,JSON};vm.createContext(context);
 const normalizers=html.slice(html.indexOf('function cleanTrackingText('),html.indexOf('function validGtinChecksumUi('));
 const statuses=html.slice(html.indexOf('const TSTATUS='),html.indexOf('/* ===== Données de démonstration ===== */'));
 // Le bloc d'affichage utilise un DOM seulement au moment de dessiner la barre.
 context.window=context;
 context.carrierOf=()=>({label:'DPD'});
 context.esc=v=>String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
 context.fmtDate=v=>new Date(v).toISOString();
 vm.runInContext(normalizers+'\n'+statuses,context);
 return context;
}
test('régression : l’interface montre un statut marketplace connu, même sans API transporteur',()=>{
 const ui=uiContext();
 const t=ui.normalizeDisplayTracking({number:N,carrier:'dpd',status:'inconnu',statusRaw:'Delivered',statusSource:'marketplace'});
 assert.equal(ui.trackingStatusInfo(t).label,'Livré');
 assert.match(ui.trackBar(t),/Livré/);
 assert.match(ui.trackingSourceLabel(t),/marketplace/);
});
test('régression : l’interface conserve un libellé inconnu utile',()=>{
 const ui=uiContext();
 const t=ui.normalizeDisplayTracking({number:N,carrier:'dpd',status:'inconnu',statusRaw:'ETAT_ABC'});
 assert.match(ui.trackingStatusInfo(t).label,/ETAT_ABC/);
 assert.doesNotMatch(ui.trackingStatusInfo(t).label,/non vérifié/);
});
test('régression : le rechargement conserve le statut connu du même colis',()=>{
 const ui=uiContext();
 ui.claims=[{id:'x',tracking:{number:N,carrier:'dpd',status:'livre',statusSource:'marketplace'}}];
 ui.trackingLiveCache=new Map();ui.trackingLiveKey=t=>`${t.carrier}|${t.number}`;
 ui.applyLiveTracking=()=>false;ui.businessStatus=()=> 'nouveau';ui.slaInfo=()=>({hours:1});
 vm.runInContext(functionSource(html,'prepareClaimsForDisplay'),ui);
 const rows=ui.prepareClaimsForDisplay([{id:'x',tracking:{number:N,carrier:'dpd',status:'inconnu'}}]);
 assert.equal(rows[0].tracking.status,'livre');
});

test('régression : Fnac/Darty Received est affiché comme Livré, sans généraliser aux autres marketplaces',()=>{
 const ui=uiContext();
 for(const mp of ['fnac','darty']){
  const t=ui.normalizeDisplayTrackingForMarketplace({number:N,carrier:'dpd',status:'inconnu',statusRaw:'Received',statusSource:'marketplace'},mp);
  assert.equal(t.status,'livre',mp);
  assert.equal(ui.trackingStatusInfo(t).label,'Livré',mp);
  assert.equal(t.statusSource,'marketplace',mp);
 }
 const other=ui.normalizeDisplayTrackingForMarketplace({number:N,carrier:'dpd',status:'inconnu',statusRaw:'Received',statusSource:'marketplace'},'carrefour');
 assert.equal(other.status,'inconnu');
 assert.match(ui.trackingStatusInfo(other).label,/Received/);
});
