'use strict';
const T=require('./tracking-status');
function error(message,code='TRACKING_UPSTREAM_ERROR',statusCode=502){return Object.assign(new Error(message),{code,statusCode});}
function id(v){return String(v??'').replace(/[^a-z0-9]/gi,'').toUpperCase();}
function normalizeLaposteResponse(data,number,carrier='colissimo'){
  const item=Array.isArray(data)?data.find(x=>id(x?.shipment?.idShip)===id(number)):data;
  if(!item||typeof item!=='object')throw error('Aucun suivi La Poste correspondant au numéro demandé.','TRACKING_NOT_FOUND',503);
  if(item.returnCode!=null&&!['0','200'].includes(String(item.returnCode)))throw error('La Poste : '+(T.statusText(item.returnMessage)||'suivi indisponible')+'.','TRACKING_UPSTREAM_ERROR');
  const sh=item.shipment;
  if(!sh||typeof sh!=='object')throw error('Aucun envoi dans la réponse La Poste.','TRACKING_NOT_FOUND',503);
  if(sh.idShip&&id(sh.idShip)!==id(number))throw error('Le numéro de suivi ne correspond pas à la réponse La Poste.','TRACKING_NUMBER_MISMATCH');
  // Le schéma Suivi v2 expose event, timeline, deliveryDate et isFinal.
  // Il ne garantit pas de champ shipment.status. Ne pas confondre un code de
  // retour HTTP avec le statut du colis.
  const events=(Array.isArray(sh.event)?sh.event:[]).map(e=>({at:e.date||e.timestamp,label:e.label||e.description||'',code:e.code||e.eventCode||e.status||''}));
  const timeline=Array.isArray(sh.timeline)?sh.timeline:[];
  const lastStep=timeline.find(e=>Number(e.id)===5&&e.status===true&&(e.type==null||Number(e.type)===1));
  if(lastStep)events.push({at:lastStep.date||sh.deliveryDate||null,label:lastStep.longLabel||lastStep.shortLabel||'Votre colis est livré',code:'TIMELINE_5'});
  const evs=T.eventsOf(events,carrier),latest=evs[0];
  const direct=T.statusCandidate([sh.statusCode,sh.currentStatus,sh.status],carrier);
  let selected=T.pick(direct,evs,carrier);
  const directAt=T.date(sh.statusAt||sh.status?.date);
  if(latest&&directAt!=null&&latest.at!=null&&latest.at>directAt)selected={status:latest.status,raw:latest.label,at:latest.at};
  // La Poste marque isFinal à la fin de l'acheminement. On ne l'utilise pas
  // seul comme preuve de remise : un retour/incident peut être final lui aussi.
  const finalDate=T.date(sh.deliveryDate);
  if(sh.isFinal===true&&finalDate!=null&&selected.status!=='livre'&&selected.status!=='incident'&&(!latest||latest.at==null?selected.status==='inconnu':latest.at<=finalDate)){
    selected={status:'livre',raw:'Livraison confirmée par La Poste',at:finalDate};
  }
  if(latest?.status==='incident'&&selected.status==='livre'&&/retour|expediteur|sender/i.test(latest.label)){selected={status:'incident',raw:latest.label,at:latest.at};}
  const raw=T.statusText(sh.status?.label||sh.status?.description||selected.raw);
  const result=T.fromCarrierResponse({status:selected.status,statusRaw:raw&&T.classify(raw,carrier)===selected.status?raw:selected.raw,statusAt:selected.at??directAt,events:evs,statusMethod:'api'},carrier,number);
  if(!result||result.status==='inconnu')throw error('La Poste ne fournit aucun état de livraison exploitable.','TRACKING_RESPONSE_UNSUPPORTED',503);
  return result;
}
module.exports={normalizeLaposteResponse};
