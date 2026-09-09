'use strict';
const T = require('./tracking-status');
const {createPageTracking} = require('./tracking-pages');
const {trackChronopostPublic}=require('./tracking-chronopost');
const {normalizeLaposteResponse}=require('./tracking-laposte');

// Adaptateurs de suivi : seuls les contrats documentés sont activés.
// Les API marketplaces, les numéros de commande et les pages HTML ne sont
// jamais utilisés comme preuve de livraison du transporteur.
function createCarrierTracking({fetch, env=process.env}) {
  const oauthCache = new Map();
  const pageTracking=createPageTracking({fetch,env});
  const supported = new Set(['colissimo','chronopost','ups','dhl','fedex','tnt']);
  function error(message,statusCode=502,code='TRACKING_UNAVAILABLE') {
    return Object.assign(new Error(message),{statusCode,code});
  }
  function required(name) {
    if (!env[name]) throw error(`Suivi non configuré : ${name} manquant.`,503,'TRACKING_NOT_CONFIGURED');
    return env[name];
  }
  async function json(url,options={}) {
    const controller=new AbortController();
    const timeout=setTimeout(()=>controller.abort(),15000);
    try {
      const r=await fetch(url,{...options,signal:controller.signal,redirect:'error'});
      if (!r.ok) {
        const code=r.status===429?'TRACKING_RATE_LIMITED':r.status===401||r.status===403?'TRACKING_AUTH_ERROR':'TRACKING_UPSTREAM_ERROR';
        throw error(r.status===429?'Quota du transporteur atteint.':r.status===401||r.status===403?'Authentification transporteur refusée.':`Transporteur : HTTP ${r.status}.`,r.status===429?429:502,code);
      }
      const body=await r.json();
      if (!body || typeof body!=='object') throw error('Réponse transporteur invalide.');
      return body;
    } catch(e) {
      if(e.name==='AbortError') throw error('Délai de réponse du transporteur dépassé.',504,'TRACKING_TIMEOUT');
      if(e.statusCode) throw e;
      throw error('Connexion au transporteur impossible.');
    } finally {clearTimeout(timeout);}
  }
  async function token(key,url,body,headers) {
    const old=oauthCache.get(key);
    if(old && old.expires>Date.now()) return old.value;
    const data=await json(url,{method:'POST',headers,body});
    if(!data.access_token) throw error('Jeton transporteur absent.');
    const value=data.access_token;
    oauthCache.set(key,{value,expires:Date.now()+Math.max(30,Number(data.expires_in||3600)-120)*1000});
    return value;
  }
  function normalizeResult(raw,carrier,number) {
    const result=T.fromCarrierResponse(raw,carrier,number);
    if(!result || result.status==='inconnu') {
      // Aucun statut vérifiable : ne pas annoncer une livraison par défaut.
      return result || T.normalize({carrier,number,status:'inconnu',statusSource:'inconnu'});
    }
    return result;
  }
  function parcelId(value) { return String(value || '').replace(/[^a-z0-9]/gi,'').toUpperCase(); }
  function matchingParcel(items, number, getNumber, label) {
    const list=Array.isArray(items)?items:[];
    const wanted=parcelId(number);
    const match=list.find(item=>parcelId(getNumber(item))===wanted);
    if(match)return match;
    // Une réponse multi-colis ne doit jamais attribuer la livraison d'un
    // autre colis à la commande demandée. Une réponse sans ID n'est tolérée
    // que si elle ne contient qu'un seul colis.
    if(list.length===1&&!parcelId(getNumber(list[0])))return list[0];
    throw error(`Le numéro de suivi demandé ne correspond pas à la réponse ${label}.`,502,'TRACKING_NUMBER_MISMATCH');
  }
  function lpCurrent(sh) {
    // La Poste Suivi v2 fournit un statut harmonisé au niveau shipment.
    // La valeur de l'historique ne doit pas remplacer ce statut courant.
    const status=sh.status;
    return status && typeof status==='object' ? (status.statusCode??status.code??status.status??status.label??status.description) : status;
  }
  async function laposte(number,carrier) {
    const data=await json(`https://api.laposte.fr/suivi/v2/idships/${encodeURIComponent(number)}?lang=fr_FR`,{
      headers:{'X-Okapi-Key':required('LAPOSTE_OKAPI_KEY'),Accept:'application/json'}
    });
    if(data.returnCode && Number(data.returnCode)!==200) throw error('Suivi La Poste indisponible.');
    return normalizeLaposteResponse(data,number,carrier);
  }
  async function ups(number) {
    const basic=Buffer.from(`${required('UPS_CLIENT_ID')}:${required('UPS_CLIENT_SECRET')}`).toString('base64');
    const access=await token('ups','https://onlinetools.ups.com/security/v1/oauth/token','grant_type=client_credentials',{
      Authorization:`Basic ${basic}`,'Content-Type':'application/x-www-form-urlencoded'
    });
    const data=await json(`https://onlinetools.ups.com/api/track/v1/details/${encodeURIComponent(number)}`,{
      headers:{Authorization:`Bearer ${access}`,Accept:'application/json',transId:'2kings-tracking',transactionSrc:'2kings'}
    });
    const shipments=data.trackResponse?.shipment||[];
    const packages=shipments.flatMap(s=>s.package||[]);
    const pkg=matchingParcel(packages,number,p=>p.trackingNumber,'UPS');
    const events=(pkg.activity||[]).map(a=>({
      at:a.date&&/^\d{8}$/.test(String(a.date))?`${String(a.date).slice(0,4)}-${String(a.date).slice(4,6)}-${String(a.date).slice(6,8)}T${String(a.time||'000000').padStart(6,'0').replace(/^(\d{2})(\d{2})(\d{2})$/,'$1:$2:$3')}`:(a.date||a.timestamp),
      label:a.status?.description||'',code:a.status?.code||'',status:a.status?.type||''
    }));
    const current=pkg.currentStatus||{};
    return normalizeResult({status:current.code||current.type||current.description,statusRaw:current.description||current.code,statusAt:pkg.deliveryDate?.find?.(d=>d.type==='DEL')?.date||null,events},'ups',number);
  }
  async function dhl(number) {
    const data=await json(`https://api-eu.dhl.com/track/shipments?trackingNumber=${encodeURIComponent(number)}&language=fr`,{
      headers:{'DHL-API-Key':required('DHL_API_KEY'),Accept:'application/json'}
    });
    const sh=matchingParcel(data.shipments,number,s=>s.id||s.trackingNumber,'DHL');
    const events=(sh.events||[]).map(e=>({at:e.timestamp||e.date,label:e.description||e.status||e.statusCode||'',code:e.statusCode||''}));
    const current=sh.status||{};
    return normalizeResult({status:current.statusCode||current.status||current.description,statusRaw:current.description||current.status||current.statusCode,statusAt:current.timestamp||null,events},'dhl',number);
  }
  async function fedex(number,carrier='fedex') {
    const access=await token('fedex','https://apis.fedex.com/oauth/token',new URLSearchParams({
      grant_type:'client_credentials',client_id:required('FEDEX_CLIENT_ID'),client_secret:required('FEDEX_CLIENT_SECRET')
    }).toString(),{'Content-Type':'application/x-www-form-urlencoded'});
    const data=await json('https://apis.fedex.com/track/v1/trackingnumbers',{
      method:'POST',headers:{Authorization:`Bearer ${access}`,'Content-Type':'application/json'},
      body:JSON.stringify({trackingInfo:[{trackingNumberInfo:{trackingNumber:number}}],includeDetailedScans:true})
    });
    const results=(data.output?.completeTrackResults||[]).flatMap(r=>r.trackResults||[]);
    const tr=matchingParcel(results,number,r=>r.trackingNumberInfo?.trackingNumber,'FedEx');
    const events=(tr.scanEvents||[]).map(e=>({at:e.date,label:e.eventDescription||e.derivedStatus||'',code:e.eventType||e.derivedStatusCode||''}));
    const current=tr.latestStatusDetail||{};
    return normalizeResult({status:current.code||current.derivedCode||tr.derivedStatusCode||current.description,statusRaw:current.description||current.derivedStatus||current.code,statusAt:tr.dateAndTimes?.find?.(d=>d.type==='ACTUAL_DELIVERY')?.dateTime||current.timestamp||null,events},carrier,number);
  }
  const apiConfigured = carrier => ({
    colissimo:!!env.LAPOSTE_OKAPI_KEY,chronopost:!!env.LAPOSTE_OKAPI_KEY,
    ups:!!env.UPS_CLIENT_ID&&!!env.UPS_CLIENT_SECRET,dhl:!!env.DHL_API_KEY,
    fedex:!!env.FEDEX_CLIENT_ID&&!!env.FEDEX_CLIENT_SECRET,tnt:!!env.FEDEX_CLIENT_ID&&!!env.FEDEX_CLIENT_SECRET
  })[carrier]||false;
  const publicApiConfigured=carrier=>carrier==='chronopost'&&env.CHRONOPOST_PUBLIC_TRACKING!=='0';
  const configured=carrier=>apiConfigured(carrier)||publicApiConfigured(carrier)||pageTracking.configured(carrier);
  async function track(carrier,number,options={}) {
    const c=String(carrier||'').toLowerCase();
    if(!supported.has(c)&&!pageTracking.supported.has(c)) throw error(`Suivi direct ${c||'transporteur'} non branché.`,503,'TRACKING_NOT_CONFIGURED');
    if(!configured(c))throw error(`Suivi ${c} non configuré.`,503,'TRACKING_NOT_CONFIGURED');
    const failures=[];
    let unknown=null;
    async function attempt(label,fn){
      try{
        const result=await fn();
        if(result?.status&&result.status!=='inconnu')return result;
        if(result)unknown=result;
      }catch(e){failures.push({label,error:e});}
      return null;
    }
    if(apiConfigured(c)){
      const result=await attempt('API officielle',async()=>{
        const r=c==='colissimo'||c==='chronopost'?await laposte(number,c):c==='ups'?await ups(number):c==='dhl'?await dhl(number):await fedex(number,c);
        return {...r,statusMethod:'api'};
      });
      if(result)return result;
    }
    if(publicApiConfigured(c)){
      const result=await attempt('Webservice public Chronopost',()=>trackChronopostPublic(fetch,number));
      if(result)return result;
    }
    if(pageTracking.configured(c)){
      const result=await attempt('Page publique',()=>pageTracking.track(c,number,options.url||'',options));
      if(result)return result;
    }
    const message=failures.map(f=>`${f.label} : ${f.error.message}`).join(' | ');
    if(unknown)return {...unknown,verificationError:message,verificationAt:Date.now()};
    const preferred=failures.find(f=>['TRACKING_NUMBER_MISMATCH','INVALID_TRACKING_NUMBER','TRACKING_AUTH_ERROR','TRACKING_RATE_LIMITED','TRACKING_ACCESS_REQUIRED'].includes(f.error.code))?.error||failures[0]?.error;
    throw error(message||`Suivi ${c} indisponible.`,preferred?.statusCode||503,preferred?.code||'TRACKING_NOT_CONFIGURED');
  }
  return {track,configured,apiConfigured,publicApiConfigured,pageTracking,supported:new Set([...supported,...pageTracking.supported])};
}
module.exports={createCarrierTracking};
