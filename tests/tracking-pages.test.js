'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {createPageTracking,parseTrackingPage,validatePageUrl,canonicalUrl,matchingId,publicAddress}=require('../lib/tracking-pages');
const N='10654000122441',NOW='2026-09-07T12:00:00Z';
const base='https://trace.dpd.fr/trace-particuliers/'+N;
// Fixtures synthétiques reproduisant les structures documentées, pas une
// copie d'une réponse de production. Aucun identifiant client n'est utilisé.
function dpdPage(rows,number=N,extra=''){
 return `<html><body><h1>Suivi de votre livraison en temps réel</h1><h2>Votre colis ${number}</h2><div>Colis remis à DPD · En transit · En cours de livraison · Colis livré</div><dl><dt>N° colis</dt><dd>${number}</dd></dl>${extra}<h2>Les étapes de ma livraison</h2><table><thead><tr><th>Date</th><th>Heure</th><th>Les étapes de ma livraison</th><th>Localisation</th></tr></thead><tbody>${rows.map(r=>`<tr><td>${r[0]}</td><td>${r[1]}</td><td>${r[2]}</td><td>${r[3]||''}</td></tr>`).join('')}</tbody></table><footer>Quand mon statut affiche colis livré alors que je n'ai rien reçu ?</footer></body></html>`;
}
const row=(d,h,s,l='')=>[d,h,s,l];
const parse=(html,carrier='dpd',number=N)=>parseTrackingPage(html,{carrier,number,url:canonicalUrl(carrier,number)});
test('DPD : dernier scan livré et date, pas la barre de progression',()=>{
 const result=parse(dpdPage([row('07/09/2026','14:00','Votre colis est livré','Belfort'),row('06/09/2026','10:00','En transit','Lyon')]));
 assert.equal(result.status,'livre');assert.equal(result.statusSource,'transporteur');assert.equal(result.statusMethod,'page');
 assert.equal(result.events.length,2);assert.equal(result.events[0].status,'livre');
 assert.ok(result.statusAt);assert.ok(result.checkedAt);
});
test('DPD : une étape Livré décorative ne prouve rien',()=>{
 const result=parse(dpdPage([row('07/09/2026','14:00','En transit','Lyon')]));assert.equal(result.status,'en_transit');
});
test('DPD : retour à expéditeur n’est pas une livraison client',()=>{
 const result=parse(dpdPage([row('07/09/2026','14:00','Votre colis est livré','Retourné à l’expéditeur'),row('06/09/2026','10:00','Votre colis sera retourné à l’expéditeur','Lyon')]));assert.equal(result.status,'incident');
});
test('DPD : ancien scan livré ne masque pas le retour ultérieur',()=>{
 const result=parse(dpdPage([row('07/09/2026','14:00','Retour à l’expéditeur','Lyon'),row('06/09/2026','10:00','Votre colis est livré','Paris')]));assert.equal(result.status,'incident');
});
test('DPD : notification et FAQ exclues de l’historique',()=>{
 const result=parse(dpdPage([row('07/09/2026','14:00','Le destinataire est informé par SMS de la livraison de son colis ce jour'),row('07/09/2026','12:00','En cours de livraison')]));assert.equal(result.status,'en_transit');assert.equal(result.events.length,1);
});
test('DPD : aucune preuve dans le HTML',()=>assert.throws(()=>parse(dpdPage([])),e=>e.code==='TRACKING_PAGE_UNSUPPORTED'));
test('DPD : numéro absent ou autre colis refusé',()=>{
 assert.throws(()=>parse(dpdPage([row('07/09/2026','12:00','Livré')],'10654000122442')),e=>e.code==='TRACKING_NUMBER_MISMATCH');
 assert.throws(()=>parse(dpdPage([row('07/09/2026','12:00','Livré')],N,'<h2>Votre colis 10658000986984</h2>')),e=>e.code==='TRACKING_AMBIGUOUS');
});
test('DPD : suffixe de contrôle documenté accepté, pas un préfixe arbitraire',()=>{
 assert.equal(matchingId('250022317509792','250022317509792780','dpd'),true);
 assert.equal(matchingId(N,N+'9999','dpd'),false);
});
test('GLS : donnée de livraison explicite liée au bon numéro',()=>{
 const html=`<html><script type="application/json" id="__NEXT_DATA__">${JSON.stringify({props:{shipments:[{trackingNumber:'36631234567',deliveryStatus:'Delivered',statusAt:NOW,events:[{at:NOW,label:'Delivered'}]},{trackingNumber:'36631234568',deliveryStatus:'In transit'}]}})}</script><p>Livraison prévue demain</p></html>`;
 assert.equal(parse(html,'gls','36631234567').status,'livre');
 assert.equal(parse(html,'gls','36631234568').status,'en_transit');
 assert.throws(()=>parse(html,'gls','36631234569'),e=>e.code==='TRACKING_PAGE_UNSUPPORTED');
});
test('GLS : page d’accueil ou de recherche sans résultat ne signifie pas livré',()=>{
 assert.throws(()=>parse('<h1>Suivi colis</h1><p>Livré · En transit · Incident</p>','gls','36631234567'),e=>e.code==='TRACKING_PAGE_UNSUPPORTED');
});
test('ChezVous : statut lié à la commande, pas l’état du paiement',()=>{
 const n='FGRC45BKLM';
 const html=`<h1>Votre commande : ${n}</h1><script type="application/json">${JSON.stringify({tracking:{number:n,deliveryStatus:'En cours de livraison',events:[{at:NOW,label:'En cours de livraison'}]}})}</script>`;
 assert.equal(parse(html,'chezvous',n).status,'en_transit');
});
test('Données JSON : ne pas reprendre le statut d’une autre commande',()=>{
 const html=`<script type="application/ld+json">${JSON.stringify({shipments:[{number:N,status:'Delivered'},{number:'10654000122442',status:'In transit'}]})}</script>`;
 assert.equal(parse(html).status,'livre');
});
test('JSON : un statut de commande générique n’est pas une preuve de livraison',()=>{
 assert.throws(()=>parse(`<script type="application/json">${JSON.stringify({orders:[{number:N,status:'DELIVERED'}]})}</script>`),e=>e.code==='TRACKING_PAGE_UNSUPPORTED');
});
test('URLs : liste blanche stricte et correspondance du numéro',()=>{
 assert.equal(validatePageUrl(base,'dpd',N),base);
 for(const url of ['http://trace.dpd.fr/trace-particuliers/'+N,'https://trace.dpd.fr.evil.test/trace-particuliers/'+N,'https://127.0.0.1/trace-particuliers/'+N,'https://trace.dpd.fr@evil.test/trace-particuliers/'+N,'https://trace.dpd.fr/trace-particuliers/10654000122442','https://trace.dpd.fr/trace-particuliers/'+N+'?url=http://localhost','https://trace.dpd.fr/robots.txt'])assert.throws(()=>validatePageUrl(url,'dpd',N));
 assert.equal(canonicalUrl('gls','36631234567').includes('match=36631234567'),true);
});
test('Réseau : adresses privées et réservées refusées',()=>{
 for(const ip of ['127.0.0.1','10.1.2.3','172.16.0.1','192.168.1.1','169.254.169.254','::1','fc00::1','::ffff:127.0.0.1'])assert.equal(publicAddress(ip),false,ip);
 assert.equal(publicAddress('1.1.1.1'),true);
});
function response(body,status=200,type='text/html'){
 return {ok:status>=200&&status<300,status,headers:{get:k=>k==='content-type'?type:null},text:async()=>body};
}
test('HTTP : robots, sans authentification ni cookies, cache robots et résultat',async()=>{
 const calls=[];const fetch=async(url,options)=>{calls.push({url,options});return url.endsWith('/robots.txt')?response('User-agent: *\nDisallow: /private\nAllow: /trace-particuliers/'):response(dpdPage([row('07/09/2026','12:00','Livré')]))};
 const service=createPageTracking({fetch,env:{TRACKING_PAGE_INTERVAL_MS:'1000'}});
 const a=await service.track('dpd',N);const b=await service.track('dpd',N);
 assert.equal(a.status,'livre');assert.equal(b.status,'livre');assert.equal(calls.filter(x=>x.url.endsWith('/robots.txt')).length,1);
 assert.ok(calls.every(x=>!x.options.headers.Authorization&&!x.options.headers.Cookie&&x.options.redirect==='manual'));
});
test('HTTP : robots interdit le suivi, aucun appel à la page',async()=>{
 const calls=[];const service=createPageTracking({fetch:async(url)=>{calls.push(url);return response('User-agent: *\nDisallow: /');},env:{}});
 await assert.rejects(service.track('dpd',N),e=>e.code==='TRACKING_ACCESS_REQUIRED');assert.equal(calls.length,1);
});
test('HTTP : erreur 429 explicite, aucun contournement',async()=>{
 const service=createPageTracking({fetch:async()=>response('',429),env:{}});
 await assert.rejects(service.track('dpd',N),e=>e.code==='TRACKING_RATE_LIMITED');
});
