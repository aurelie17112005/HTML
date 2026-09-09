'use strict';
// Webservice public Chronopost trackSkybillV2. Aucun compte expéditeur requis.
// Contrat documenté par Chronopost : TrackingServiceWS, version 2.5.11, §2.9.2.
const {parseTrackingXml}=require('./tracking-xml');
const T=require('./tracking-status');
const ENDPOINT='https://ws.chronopost.fr/tracking-cxf/TrackingServiceWS/trackSkybillV2';
const TRACKING_NUMBER=/^[a-z0-9._-]{6,60}$/i;
function error(message,code='TRACKING_UPSTREAM_ERROR',statusCode=502){return Object.assign(new Error(message),{code,statusCode});}
function id(v){return String(v??'').replace(/[^a-z0-9]/gi,'').toUpperCase();}
function text(v){return T.statusText(v);}
function asArray(v){return v==null?[]:Array.isArray(v)?v:[v];}
function parseChronopostResponse(xml,number){
  if(typeof xml!=='string'||xml.length>1024*1024||/<!\s*(?:DOCTYPE|ENTITY)/i.test(xml))throw error('Réponse XML Chronopost invalide.','TRACKING_RESPONSE_INVALID');
  let document;
  try{document=parseTrackingXml(xml);}
  catch{throw error('Réponse XML Chronopost invalide.','TRACKING_RESPONSE_INVALID');}
  const body=document?.Envelope?.Body||document?.Body||document;
  const response=body?.trackSkybillV2Response||body?.trackSkybillResponse||body;
  const result=response?.return||response?.result||response;
  if(!result||typeof result!=='object'||Array.isArray(result)||result.Fault||body?.Fault)throw error('Réponse Chronopost invalide ou refusée.','TRACKING_RESPONSE_INVALID');
  const code=text(result.errorCode??result.returnCode??'0');
  if(code&&!['0','200'].includes(code))throw error('Chronopost a refusé la recherche de suivi (code '+code.slice(0,16)+').','TRACKING_UPSTREAM_ERROR');
  const returned=id(result.skybillNumber||result.trackingNumber||result.idShip||result.skybill);
  if(returned&&returned!==id(number))throw error('Le numéro retourné par Chronopost ne correspond pas au colis demandé.','TRACKING_NUMBER_MISMATCH');
  // Selon la version SOAP, listEvents est directement un tableau ou une
  // structure ListEvents contenant un tableau events. Vérifier chaque groupe
  // et chaque événement : ne jamais récupérer le statut d'un autre colis.
  const events=[];
  function collect(value,depth=0){
    if(value==null)return;
    if(depth>5||events.length>2000)throw error('Historique Chronopost trop complexe.','TRACKING_RESPONSE_INVALID');
    for(const e of asArray(value)){
      if(!e||typeof e!=='object')continue;
      const eventNumber=id(e.skybillNumber||e.trackingNumber||e.idShip);
      if(eventNumber&&eventNumber!==id(number))throw error('Un événement Chronopost concerne un autre colis.','TRACKING_NUMBER_MISMATCH');
      if(e.events!=null||e.listEvents!=null){
        collect(e.events??e.listEvents,depth+1);
      }else if(e.eventDate!=null||e.eventLabel!=null||e.eventCode!=null){
        events.push({at:e.eventDate||e.date||e.timestamp||null,label:text(e.eventLabel||e.label||e.description),code:text(e.eventCode||e.code||''),status:text(e.eventStatus||'')});
      }
    }
  }
  collect(result.listEvents??result.events??result.trackEvents);
  const normalized=T.eventsOf(events,'chronopost');
  const latest=normalized[0];
  const direct=T.statusCandidate([result.currentStatus,result.deliveryStatus,result.shippingStatus,result.status],'chronopost');
  let chosen=T.pick(direct,normalized,'chronopost');
  const directAt=T.date(result.statusAt||result.statusDate||result.lastEventDate);
  if(latest&&directAt!=null&&latest.at!=null&&latest.at>directAt)chosen={status:latest.status,raw:latest.label,at:latest.at};
  if(latest?.status==='incident'&&chosen.status==='livre'&&/retour|expediteur|sender/i.test(latest.label)){chosen={status:'incident',raw:latest.label,at:latest.at};}
  const raw=text(result.statusLabel||result.statusDescription||chosen.raw);
  const statusRaw=raw&&T.classify(raw,'chronopost')===chosen.status?raw:chosen.raw;
  const final=T.fromCarrierResponse({status:chosen.status,statusRaw:statusRaw||chosen.raw,statusAt:chosen.at??directAt,events:normalized,statusMethod:'api',sourceUrl:'https://www.chronopost.fr/fr/suivi-colis'},'chronopost',number);
  if(!final||final.status==='inconnu')throw error('Aucun état de livraison exploitable dans la réponse Chronopost.','TRACKING_RESPONSE_UNSUPPORTED',503);
  return final;
}
async function trackChronopostPublic(fetch,number){
  if(!TRACKING_NUMBER.test(String(number||''))||!/\d/.test(String(number)))throw error('Numéro Chronopost invalide.','INVALID_TRACKING_NUMBER',400);
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),12000);
  try{
    const url=ENDPOINT+'?'+new URLSearchParams({language:'fr_FR',skybillNumber:number});
    const r=await fetch(url,{method:'GET',headers:{Accept:'application/xml, text/xml;q=0.9'},redirect:'error',signal:controller.signal});
    if(r.status===429)throw error('Quota Chronopost atteint.','TRACKING_RATE_LIMITED',429);
    if(r.status===401||r.status===403)throw error('Accès au suivi public Chronopost refusé.','TRACKING_ACCESS_REQUIRED',503);
    if(!r.ok)throw error('Chronopost : HTTP '+r.status+'.');
    if(Number(r.headers?.get?.('content-length')||0)>1024*1024)throw error('Réponse Chronopost trop volumineuse.','TRACKING_RESPONSE_INVALID');
    const body=await r.text();
    return parseChronopostResponse(body,number);
  }catch(e){
    if(e.name==='AbortError')throw error('Délai de réponse Chronopost dépassé.','TRACKING_TIMEOUT',504);
    if(e.statusCode)throw e;
    throw error('Connexion au webservice Chronopost impossible.','TRACKING_UPSTREAM_ERROR');
  }finally{clearTimeout(timer);}
}
module.exports={trackChronopostPublic,parseChronopostResponse,ENDPOINT};
