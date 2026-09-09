/* Normalisation commune navigateur/serveur. Aucune donnée de suivi n'est inventée. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TrackingStatus = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const KNOWN = new Set(['inconnu','en_attente','en_transit','pret_retrait','livre','incident']);
  const text = v => v == null ? '' : String(v).trim();
  // Les statuts peuvent être des objets API : ne jamais afficher [object Object].
  function statusText(v) {
    if (v == null) return '';
    if (typeof v !== 'object') return text(v);
    for (const k of ['statusCode','code','status','state','value','description','label','name','text']) {
      if (v[k] != null && v[k] !== v) { const result=statusText(v[k]); if(result) return result; }
    }
    return '';
  }
  function statusCandidate(values,carrier='') {
    let unknown='';
    for(const value of values) {
      // Un code inconnu peut être accompagné d'un libellé reconnu dans le
      // même objet. Examiner les deux évite de perdre le statut courant.
      const raw=value && typeof value==='object' ? statusCandidate(
        ['statusCode','code','status','state','value','description','label','name','text'].map(k=>value[k]),carrier
      ) : statusText(value);
      if(!raw)continue;
      if(classify(raw,carrier)!=='inconnu')return raw;
      if(!unknown || /^(?:unknown|inconnu|n\/?a|null|undefined)$/i.test(unknown))unknown=raw;
    }
    return unknown;
  }
  const fold = v => text(v).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
  function date(v) {
    if (v == null || v === '') return null;
    const compact = text(v).match(/^(\d{4})(\d{2})(\d{2})(?:[ T]?(\d{2})(\d{2})(\d{2})?)?$/);
    if (compact) { const d=new Date(`${compact[1]}-${compact[2]}-${compact[3]}T${compact[4]||'00'}:${compact[5]||'00'}:${compact[6]||'00'}`).getTime(); return Number.isFinite(d)?d:null; }
    if (typeof v === 'number' || /^\d+$/.test(String(v))) {
      const n = Number(v); return Number.isFinite(n) ? (Math.abs(n) < 1e11 ? n * 1000 : n) : null;
    }
    // Les API UPS renvoient YYYYMMDD et HHmmss séparément.
    const d = Date.parse(text(v));
    return Number.isFinite(d) ? d : null;
  }
  function classify(value, carrier='') {
    if (value && typeof value === 'object') return classify(statusCandidate([value.statusCode,value.code,value.status,value.state,value.value,value.description,value.label,value.name,value.text],carrier),carrier);
    const s=fold(value).replace(/[_-]+/g,' '), c=fold(carrier), code=text(value).toUpperCase();
    if (!s || ['unknown','inconnu','n/a','null','undefined'].includes(s)) return 'inconnu';
    if (KNOWN.has(s.replace(/ /g,'_'))) return s.replace(/ /g,'_');
    if (['colissimo','chronopost'].includes(c)) {
      if (['LIVCFM','TIMELINE_5'].includes(code)) return 'livre';
      if (code==='AARBPR') return 'pret_retrait';
      if (['PRELIV','PCHTRI'].includes(code)) return 'en_transit';
      if (code==='PCHMQT') return 'en_attente';
    }
    if (['fedex','tnt'].includes(c)) {
      if (code==='DL') return 'livre';
      if (['OD','PU','AR','DP','IT'].includes(code)) return 'en_transit';
      if (code==='OC') return 'en_attente';
    }
    if (c==='ups') {
      if (['D','DEL'].includes(code)) return 'livre';
      if (code==='X') return 'incident';
      if (code==='I') return 'en_transit';
      if (code==='M') return 'en_attente';
    }
    if (/^(?:delivered|delivery completed|livre|livree|distribue|distribuee|proof of delivery|received by customer)$/.test(s)) return 'livre';
    // Les négations, échecs et retours ne doivent jamais être pris pour une livraison.
    if (/(?:non livr|pas (?:encore )?livr|livraison non effectuee|livraison non reussie|not (?:yet )?delivered|undelivered|delivery failed|delivery attempted|echec|failed|failure|incident|exception|anomalie|perdu|lost|refus|refused|retour|return|recipient absent|destinataire absent|adresse incorrecte)/.test(s)) return 'incident';
    if (/(?:retire par (?:le )?(?:destinataire|client)|retire par vos soins|retrait effectue|(?:a ete|est) retire\b|collected by (?:the )?(?:recipient|customer)|picked up by (?:the )?(?:recipient|customer))/.test(s)) return 'livre';
    if (/(?:remis au transporteur|livre au transporteur|handed to (?:the )?carrier|depose (?:en|au) bureau de poste)/.test(s)) return 'en_transit';
    if (/(?:en attente de retrait|awaiting collection|ready for collection|pret a retirer)/.test(s)) return 'pret_retrait';
    // Une remise à un relais ou au bureau de poste n'est pas une remise au client.
    if (/(?:point relais|relais colis|pickup point|service point|access point|consigne|bureau de poste)/.test(s) &&
        /(?:pret|ready|disponible|available|mis a disposition|a retirer|attend|awaiting collection|remis|livre|depose)/.test(s)) return 'pret_retrait';
    // Les annonces et prévisions sont examinées AVANT les confirmations.
    if (/(?:en cours de livraison|out for delivery|livraison en cours|en livraison|delivery in progress|delivery scheduled|scheduled delivery|livraison prevue|livraison estimee|estimated delivery|pour (?:vous )?etre livre|sera livre|va etre livre|devrait etre livre|livraison a venir|mise en livraison|preparons pour le mettre en livraison)/.test(s)) return 'en_transit';
    if (/(?:\b(?:est|a ete|a bien ete) livre(?:e)?\b|\blivre(?:e)?\s+(?:au|a|le|chez|dans|en mains)\b|\blivree?\s+(?:[-–:]\s*)?remis|livraison effectuee|livraison reussie|livraison confirmee|livraison terminee|livraison achevee|livraison realisee|remise effectuee|remise confirmee|remis au destinataire|remis a (?:votre|son) gardien|depose dans (?:la|votre) boite aux lettres|distribue|delivered|successfully delivered|signed for|proof of delivery|handed to (?:the )?(?:recipient|customer))/.test(s)) return 'livre';
    if (/(?:preparation|etiquette|label|enregistr|created|annonce|attente|pending|not shipped|unshipped|unfulfilled|not fulfilled|va bientot nous etre confie|pre transit|pretransit|information received|order data|shipment information|manifest)/.test(s)) return 'en_attente';
    if (/(?:expedi|shipped|fulfilled|pris en charge|accepted|collected|achemin|transit|hub|tri|route|depart|arrive|arrived|departed|in delivery|underway|transport)/.test(s)) return 'en_transit';
    return 'inconnu';
  }
  function event(e, carrier='') {
    if (!e) return null;
    const obj = typeof e === 'string' ? {label:e} : e;
    const raw = statusCandidate([obj.statusCode,obj.code,obj.status?.code,obj.status?.statusCode,obj.status?.status,obj.status,obj.state],carrier);
    const label = statusText(obj.label || obj.description || obj.eventLabel || obj.event_label || obj.message || obj.libelle || obj.activity || obj.eventDescription || obj.status?.description || raw);
    const at = date(obj.at ?? obj.date ?? obj.eventDate ?? obj.event_date ?? obj.timestamp ?? obj.timeStamp ?? obj.datetime ?? obj.created_at ?? obj.dateTime ?? (obj.h != null ? Date.now()-Number(obj.h)*3600000 : null));
    if (!label && !raw) return null;
    return {at, label:label || text(raw), code:text(typeof raw === 'object' ? (raw.code || raw.statusCode || '') : raw), status:classify(raw,carrier) !== 'inconnu' ? classify(raw,carrier) : classify(label,carrier)};
  }
  function eventsOf(raw, carrier='') {
    const result=[], seen=new Set();
    for (const e of (Array.isArray(raw) ? raw : [])) {
      const n=event(e,carrier); if (!n) continue;
      const key=`${n.at}|${n.code}|${n.label}`;
      if (!seen.has(key)) {seen.add(key);result.push(n);}
    }
    // Une date absente reste absente : elle ne devient jamais « maintenant ».
    return result.sort((a,b)=>(b.at??-Infinity)-(a.at??-Infinity)).slice(0,50);
  }
  function pick(raw, events=[], carrier='') {
    const value=statusCandidate(Array.isArray(raw)?raw:[raw],carrier);
    const direct=classify(value,carrier);
    if (direct !== 'inconnu') return {status:direct, raw:value, at:null};
    const latest=events[0];
    if (latest) return {status:latest.status || classify(latest.code || latest.label,carrier), raw:latest.label || latest.code || '', at:latest.at??null};
    return {status:'inconnu',raw:value,at:null};
  }
  function validNumber(number,carrier='') {
    return /^[a-z0-9._-]{6,60}$/i.test(text(number)) && (fold(carrier)==='chezvous'||/\d/.test(text(number)));
  }
  function chezvousReferenceFromUrl(raw) {
    if(typeof raw!=='string'||raw.length>2048||/[\u0000-\u001f\u007f]/.test(raw))return '';
    try{
      const u=new URL(raw);
      if(u.protocol!=='https:'||u.username||u.password||u.port||u.hash||!['cchezvous.fr','www.cchezvous.fr'].includes(u.hostname.toLowerCase()))return '';
      const m=u.pathname.match(/^\/suivi-colis\/([a-z0-9._-]{6,60})\/?$/i);
      if(!m||[...u.searchParams.keys()].some(k=>!['lang','locale'].includes(k.toLowerCase())))return '';
      return decodeURIComponent(m[1]);
    }catch{return '';}
  }
  function normalize(raw, fallback={}) {
    if (!raw && !fallback.number) return null;
    const r=typeof raw === 'string' ? {number:raw} : (raw||{});
    const number=text(r.number || r.trackingNumber || r.tracking_number || r.trackingCode || r.tracking_code || r.trackingId || r.tracking_id || r.parcelNumber || r.parcel_number || r.shipmentNumber || r.shipment_number || r.shipping_number || r.awb || r.waybill || fallback.number);
    const carrier=text(r.carrier || fallback.carrier || 'transporteur').toLowerCase();
    if (!validNumber(number,carrier)) return null;
    const reference=carrier==='chezvous' ? text(r.orderReference||r.carrierOrderReference||r.reference||fallback.orderReference||chezvousReferenceFromUrl(r.url||fallback.url||'')) : '';
    const orderReference=validNumber(reference,'chezvous')?reference:'';
    const evs=eventsOf(r.events || r.history || r.tracking_events || [],carrier);
    // Un code inconnu ne doit pas masquer un libellé de livraison exploitable.
    const rawStatus=statusCandidate([r.status,r.tracking_status,r.trackingStatus,r.delivery_status,r.deliveryStatus,r.shipment_status,r.shipmentStatus,r.shipping_status,r.shippingStatus,r.currentStatus,r.statusRaw],carrier);
    const selected=pick(rawStatus,evs,carrier);
    const explicitStatusAt=date(r.statusAt ?? r.status_at ?? r.lastStatusAt);
    const statusAt=explicitStatusAt ?? selected.at ?? (selected.status !== 'inconnu' && evs[0]?.status===selected.status ? (evs[0]?.at??null) : null) ?? (r.statusSource==='transporteur' ? date(r.checkedAt) : null);
    const source=r.statusSource === 'transporteur' ? 'transporteur' : (r.statusSource === 'commande' ? 'commande' : (r.statusSource === 'marketplace' ? 'marketplace' : (selected.status === 'inconnu' ? 'inconnu' : 'marketplace')));
    const description=statusText(r.statusRaw);
    const rawDescription=description && classify(description,carrier)===selected.status ? description : (selected.raw || description);
    const result={carrier,number,...(orderReference?{orderReference}:{}),status:selected.status,statusRaw:rawDescription || selected.raw,statusAt,checkedAt:date(r.checkedAt),statusSource:source,statusMethod:['page','api'].includes(r.statusMethod)?r.statusMethod:null,sourceUrl:text(r.sourceUrl),verificationError:text(r.verificationError),verificationAt:date(r.verificationAt),etaH:r.etaH??r.eta??null,events:evs,...(r.url?{url:r.url}:{})};
    // Conserver les champs de suivi reconnus, sans propager des données de commande.
    if(r.statusKind==='commande')result.statusKind='commande';
    return result;
  }
  function merge(current,extra) {
    const a=normalize(current),b=normalize(extra);
    if (!a) return b;if (!b) return a;
    // Ne jamais mélanger les événements ou le statut de deux colis différents.
    if (a.number.replace(/\s+/g,'').toUpperCase() !== b.number.replace(/\s+/g,'').toUpperCase()) return b;
    if(a.orderReference&&b.orderReference&&a.orderReference.replace(/[^a-z0-9]/gi,'').toUpperCase()!==b.orderReference.replace(/[^a-z0-9]/gi,'').toUpperCase())return b;
    const evs=eventsOf([...a.events,...b.events],b.carrier);
    let preferred=b;
    const known=x=>x.status !== 'inconnu';
    if (!known(b) && known(a)) preferred=a;
    else if (known(a) && known(b)) {
      const score=x=>x.statusSource === 'transporteur' ? 3 : x.statusSource === 'marketplace' ? 2 : x.statusSource === 'commande' ? 1 : 0;
      if (score(a)>score(b)) preferred=a;
      else if (score(a)===score(b) && a.checkedAt!=null && b.checkedAt!=null && a.checkedAt>b.checkedAt) preferred=a;
      else if (score(a)===score(b) && a.statusAt!=null && b.statusAt!=null && a.statusAt>b.statusAt && !(b.checkedAt!=null && (!a.checkedAt || b.checkedAt>=a.checkedAt))) preferred=a;
      else if (score(a)===score(b) && a.statusAt!=null && b.statusAt==null) preferred=a;
    }
    return {...a,...b,status:preferred.status,statusRaw:preferred.statusRaw,statusAt:preferred.statusAt,statusSource:preferred.statusSource,statusKind:preferred.statusKind,checkedAt:preferred.checkedAt??null,statusMethod:preferred.statusMethod,sourceUrl:preferred.sourceUrl||b.sourceUrl||a.sourceUrl,verificationError:b.statusSource==='transporteur'?b.verificationError:a.verificationError,verificationAt:b.statusSource==='transporteur'?b.verificationAt:a.verificationAt,events:evs,orderReference:b.orderReference||a.orderReference,url:b.url||a.url,etaH:b.etaH??a.etaH};
  }
  function fromCarrierResponse(raw,carrier,number,checkedAt=Date.now()) {
    if (!raw || typeof raw !== 'object') return null;
    const n=normalize({...raw,carrier,number,statusSource:'transporteur',checkedAt},{carrier,number});
    if (!n) return null;
    // Une réponse vide ou non reconnue n'atteste pas un état de livraison.
    return n;
  }
  return {classify,date,event,eventsOf,pick,normalize,merge,fromCarrierResponse,statusText,statusCandidate,validNumber,chezvousReferenceFromUrl};
});
