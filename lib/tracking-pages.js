'use strict';

// Lecture des pages PUBLIQUES de suivi. Pas de navigateur anti-bot, de compte,
// de cookies marketplace, ni de téléchargement de pièces jointes / preuves.
// Seuls les transporteurs et les chemins explicitement autorisés sont interrogés.
const https = require('node:https');
const dns = require('node:dns');
const net = require('node:net');
const {TextDecoder}=require('node:util');
const T = require('./tracking-status');
const {createBrowserRenderer}=require('./tracking-browser');

const PAGE_CARRIERS = new Set(['dpd', 'gls', 'chezvous']);
const NUMBER_RE = /^[a-z0-9._-]{6,60}$/i;
const IDENTIFIER_KEYS = ['trackingNumber','tracking_number','parcelNumber','parcel_number','shipmentNumber','shipment_number','trackingId','tracking_id','consignmentNumber','waybill','number','id'];
const STATUS_KEYS = ['trackingStatus','tracking_status','deliveryStatus','delivery_status','shipmentStatus','shipment_status','shippingStatus','shipping_status','currentStatus','latestStatus','latest_status','status'];
const EVENT_KEYS = ['events','history','trackingEvents','tracking_events','scanEvents','scan_events','trackingHistory'];
const VOID = new Set(['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr']);
const BLOCK = new Set(['p','div','section','article','header','footer','main','li','tr','table','br','h1','h2','h3','h4','h5','h6','dl','dt','dd']);
const ENTITIES = {amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' ',eacute:'é',egrave:'è',ecirc:'ê',agrave:'à',acirc:'â',ocirc:'ô',ucirc:'û',ugrave:'ù',ccedil:'ç',euml:'ë',iuml:'ï',rsquo:'’',lsquo:'‘',ndash:'–',mdash:'—',hellip:'…',bull:'•'};
function decode(s) { return String(s||'').replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);?/gi,(all,key)=>{
  if(key[0]==='#'){const n=key[1]?.toLowerCase()==='x'?parseInt(key.slice(2),16):parseInt(key.slice(1),10);return n>0&&n<=0x10ffff&&!(n>=0xd800&&n<=0xdfff)?String.fromCodePoint(n):'�';}
  return ENTITIES[key.toLowerCase()]??all;
});}
function clean(s){return decode(s).replace(/\s+/g,' ').trim();}
function fold(s){return clean(s).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();}
function id(s){return String(s||'').replace(/[^a-z0-9]/gi,'').toUpperCase();}
function matchingId(a,b,carrier){
  const x=id(a),y=id(b);if(!x||!y)return false;if(x===y)return true;
  // DPD affiche parfois 14/15 chiffres alors que le lien contient trois
  // chiffres de contrôle supplémentaires. Aucun rapprochement par préfixe libre.
  if(carrier==='dpd'&&/^\d+$/.test(x)&&/^\d+$/.test(y)){
    const shorter=x.length<y.length?x:y,longer=x.length<y.length?y:x;
    return [14,15].includes(shorter.length)&&longer.length===shorter.length+3&&longer.startsWith(shorter);
  }
  return false;
}
function error(message,code='TRACKING_PAGE_UNAVAILABLE',statusCode=502){return Object.assign(new Error(message),{code,statusCode});}
function validNumber(number,carrier=''){return NUMBER_RE.test(String(number||''))&&(carrier==='chezvous'||/\d/.test(String(number)));}
const HOSTS={
  dpd:new Set(['trace.dpd.fr']),
  gls:new Set(['gls-group.com','www.gls-group.com','gls-group.eu','www.gls-group.eu','gls-france.com','www.gls-france.com']),
  chezvous:new Set(['cchezvous.fr','www.cchezvous.fr'])
};
function allowedPath(carrier,u){
  const p=u.pathname;
  if(carrier==='dpd')return /^\/(?:trace-particuliers|fr\/trace)\/[a-z0-9._-]{6,60}\/?$/i.test(p);
  if(carrier==='gls')return /^\/(?:FR\/(?:fr|en)\/)?(?:suivi-colis|parcel-tracking)\/?$/i.test(p);
  if(carrier==='chezvous')return /^\/suivi-colis\/[a-z0-9._-]{6,60}\/?$/i.test(p);
  return false;
}
function validatePageUrl(raw,carrier,number){
  if(typeof raw!=='string'||raw.length>2048||/[\u0000-\u001f\u007f]/.test(raw))throw error('Lien de suivi invalide.','INVALID_TRACKING_URL',400);
  let u;try{u=new URL(raw);}catch{throw error('Lien de suivi invalide.','INVALID_TRACKING_URL',400);}
  if(u.protocol!=='https:'||u.username||u.password||u.port||u.hash||!HOSTS[carrier]?.has(u.hostname.toLowerCase())||!allowedPath(carrier,u))throw error('Domaine ou chemin de suivi non autorisé.','TRACKING_URL_NOT_ALLOWED',400);
  if([...u.searchParams.keys()].some(k=>!['match','parcelnumber','trackingnumber','tracking_number','tracking-id','code','lang','locale'].includes(k.toLowerCase())))throw error('Paramètres du lien de suivi non autorisés.','TRACKING_URL_NOT_ALLOWED',400);
  const embedded=[...u.searchParams.entries()].filter(([k])=>/^(match|parcelnumber|trackingnumber|tracking_number|tracking-id|code)$/i.test(k)).map(([,v])=>v);
  if(carrier!=='gls')embedded.push(decodeURIComponent(u.pathname.split('/').filter(Boolean).at(-1)||''));
  if(embedded.some(v=>!matchingId(v,number,carrier)))throw error('Le lien ne correspond pas au numéro demandé.','TRACKING_NUMBER_MISMATCH',400);
  return u.toString();
}
function canonicalUrl(carrier,number){
  if(!PAGE_CARRIERS.has(carrier)||!validNumber(number,carrier))throw error('Transporteur ou numéro non pris en charge.','TRACKING_NOT_CONFIGURED',503);
  const n=encodeURIComponent(number);
  return validatePageUrl(carrier==='dpd'?`https://trace.dpd.fr/trace-particuliers/${n}`:carrier==='gls'?`https://gls-group.com/FR/fr/suivi-colis?match=${n}`:`https://www.cchezvous.fr/suivi-colis/${n}`,carrier,number);
}
function pageUrl(carrier,number,raw){
  // Un lien reconnu venant de la marketplace est prioritaire. Les liens
  // inconnus ne sont jamais ouverts par le serveur, même avec un numéro valide.
  return raw?validatePageUrl(raw,carrier,number):canonicalUrl(carrier,number);
}

// Petit lecteur de structure HTML, sans exécution de scripts. Il ne prétend
// pas être un navigateur : les extracteurs n'utilisent que des éléments précis.
function parseHtml(html){
  const root={tag:'#root',attrs:{},children:[],parent:null},stack=[root];
  let nodes=0;const tokens=String(html).match(/<!--[\s\S]*?-->|<![^>]*>|<\/?[a-z][^>]*>|[^<]+|</gi)||[];
  for(let i=0;i<tokens.length;i++){
    const token=tokens[i],cur=stack[stack.length-1];
    if(!token.startsWith('<')){cur.children.push({tag:'#text',value:decode(token),parent:cur});continue;}
    if(/^<!/.test(token))continue;
    const m=token.match(/^<\s*(\/?)\s*([a-z][a-z0-9:-]*)/i);if(!m)continue;
    const tag=m[2].toLowerCase();
    if(m[1]){for(let j=stack.length-1;j>0;j--){if(stack[j].tag===tag){stack.length=j;break;}}continue;}
    if((tag==='tr'&&cur.tag==='tr')||(['td','th'].includes(tag)&&['td','th'].includes(cur.tag))||(tag==='li'&&cur.tag==='li')||(tag==='p'&&cur.tag==='p'))stack.pop();
    const attrs={},attrText=token.slice(m[0].length).replace(/\/?\s*>$/,'');
    const ar=/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;let a;
    while((a=ar.exec(attrText)))attrs[a[1].toLowerCase()]=decode(a[2]??a[3]??a[4]??'');
    if(++nodes>12000||stack.length>64)throw error('Structure HTML trop complexe.','TRACKING_PAGE_INVALID');
    const parent=stack[stack.length-1],node={tag,attrs,children:[],parent};parent.children.push(node);
    if(VOID.has(tag)||/\/\s*>$/.test(token))continue;
    if(tag==='script'||tag==='style'){
      const close=new RegExp(`<\\/${tag}\\s*>`,'i');let content='';
      while(i+1<tokens.length&&!close.test(tokens[i+1]))content+=tokens[++i];
      node.children.push({tag:'#text',value:content,parent:node});if(i+1<tokens.length)i++;
    }else stack.push(node);
  }
  return root;
}
function findAll(node,predicate,out=[]){for(const child of node.children||[]){if(predicate(child))out.push(child);findAll(child,predicate,out);}return out;}
function text(node){if(node.tag==='#text')return node.value;if(['script','style','template','noscript'].includes(node.tag))return '';return (node.children||[]).map(text).join(BLOCK.has(node.tag)?'\n':' ');}
function nodeText(node){return clean(text(node));}
function rawText(node){return (node.children||[]).map(c=>c.value||'').join('');}
function attr(node,key){return node.attrs?.[key]||'';}
function hasClass(node,name){return attr(node,'class').split(/\s+/).includes(name);}
function headingMatches(node,re){return /^h[1-6]$/.test(node.tag)&&re.test(nodeText(node));}
function isActualStatus(s){return T.classify(s)!=='inconnu';}
function statusString(v){return T.statusText(v);}
function frenchDate(s){
  const m=clean(s).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if(!m)return T.date(s);
  // L'heure locale des événements français est convertie en UTC avec le
  // fuseau Europe/Paris, sans supposer que l'été dure toute l'année.
  const utc=Date.UTC(+m[3],+m[2]-1,+m[1],+(m[4]||0),+(m[5]||0),+(m[6]||0));
  if(!Number.isFinite(utc))return null;
  const fmt=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Paris',timeZoneName:'shortOffset'});
  const offset=ts=>{const off=fmt.formatToParts(new Date(ts)).find(p=>p.type==='timeZoneName')?.value.match(/GMT([+-])(\d+)(?::(\d+))?/);return off?(off[1]==='-'?-1:1)*(+off[2]*60+(+off[3]||0)):60;};
  const first=utc-offset(utc)*60000;
  return utc-offset(first)*60000;
}
function statusFromEvent(label,location=''){
  if(/(?:retour|return|expediteur|sender)/i.test(fold(location))&&T.classify(label)==='livre')return 'incident';
  return T.classify(label);
}
function tableEvents(table,carrier){
  const rows=findAll(table,n=>n.tag==='tr');if(!rows.length)return [];
  const result=[];
  for(const row of rows){
    const cells=findAll(row,n=>['td','th'].includes(n.tag)&&n.parent===row).map(nodeText);
    if(cells.length<2)continue;
    const dateIndex=cells.findIndex(x=>/^\d{1,2}\/\d{1,2}\/\d{4}(?:\s|$)/.test(x)||/^\d{4}-\d{2}-\d{2}/.test(x));
    if(dateIndex<0)continue;
    let date=cells[dateIndex],next=dateIndex+1;
    if(/^\d{1,2}:\d{2}/.test(cells[next]||'')){date+=' '+cells[next];next++;}
    const at=frenchDate(date);if(at==null)continue;
    const rest=cells.slice(next);const label=rest[0]||'';
    const location=rest.slice(rest.indexOf(label)+1).join(' ');
    if(!label)continue;
    // Les notifications SMS / e-mail ne sont pas des scans du colis.
    if(/^(?:le destinataire est informe|notification|avis de passage envoye)/i.test(fold(label)))continue;
    result.push({at,label,location,status:statusFromEvent(label,location)});
  }
  return result;
}
function currentFromEvents(events,carrier){
  const evs=T.eventsOf(events,carrier);const latest=evs[0];
  return {events:evs,status:latest?.status||'inconnu',statusRaw:latest?.label||'',statusAt:latest?.at??null};
}
function extractDpd(root,number){
  const body=nodeText(root);
  const numbers=[...body.matchAll(/(?:Votre colis|N°\s*colis)\s*[:#]?\s*(\d{14,18})/gi)].map(m=>m[1]);
  const unique=[...new Set(numbers)];
  if(!unique.length)return null;
  if(!unique.some(n=>matchingId(n,number,'dpd')))throw error('Numéro DPD absent de la page.','TRACKING_NUMBER_MISMATCH',502);
  if(unique.some(n=>!matchingId(n,number,'dpd')))throw error('Page DPD multi-colis : historique non attribuable avec certitude.','TRACKING_AMBIGUOUS',502);
  // Les tables de suivi comportent des dates et des descriptions de scans.
  // Les étapes graphiques, FAQ, notifications et preuves de livraison sont ignorées.
  const tables=findAll(root,n=>n.tag==='table');
  const events=tables.flatMap(t=>tableEvents(t,'dpd'));
  const current=currentFromEvents(events,'dpd');
  if(events.length)return current;
  // Certains gabarits exposent un statut courant structuré sans tableau.
  // Ne jamais déduire la livraison de « Livré le » ou d'une étape décorative.
  return null;
}
function getIdentifier(obj,scope=false,carrier=''){
  for(const k of [...IDENTIFIER_KEYS,...(carrier==='chezvous'?['orderNumber','orderReference','order_reference','orderRef','orderId','referenceCommande']:[])]){const v=obj?.[k];if(['number','id'].includes(k)&&!scope)continue;if(typeof v==='string'||typeof v==='number'){if(validNumber(v,carrier))return String(v);}}
  return '';
}
function extractStructured(root,number,carrier){
  const candidates=[];
  function examine(obj,depth=0,scope=false,matchedOrder=false){
    if(!obj||typeof obj!=='object'||depth>8)return;
    if(Array.isArray(obj)){obj.forEach(x=>examine(x,depth+1,scope,matchedOrder));return;}
    const type=String(obj['@type']||'').toLowerCase();
    const shipmentScope=scope||/parcel|shipment|tracking|consignment|deliveryevent/.test(type);
    const orderScope=/(?:^|\W)order(?:$|\W)/.test(type);
    const ownId=getIdentifier(obj,shipmentScope,carrier);
    const match=ownId&&matchingId(ownId,number,carrier);
    if(carrier==='chezvous'&&ownId&&!match&&matchedOrder)return;
    if((match||carrier==='chezvous'&&matchedOrder&&shipmentScope&&!ownId)&&(!orderScope||carrier==='chezvous')){
      const fields=shipmentScope&&!orderScope?STATUS_KEYS:STATUS_KEYS.filter(k=>k!=='status');
      const raw=fields.map(k=>obj[k]).find(x=>isActualStatus(x))??fields.map(k=>obj[k]).find(x=>statusString(x))??'';
      let events=[];for(const k of EVENT_KEYS)if(Array.isArray(obj[k]))events=obj[k];
      if(raw||events.length)candidates.push({status:raw,statusRaw:statusString(obj.statusRaw||obj.statusDescription||obj.statusLabel||raw),statusAt:obj.statusAt||obj.statusDate||obj.lastEventDate||null,events});
    }
    for(const [k,v] of Object.entries(obj)){
      if(['__proto__','constructor','prototype'].includes(k))continue;
      if(v&&typeof v==='object'&&k!=='address'&&k!=='customer'&&k!=='recipient'&&k!=='sender'&&k!=='consignee')examine(v,depth+1,!orderScope&&(shipmentScope||/^(?:shipment|shipments|parcel|parcels|tracking|trackingData|trackingInfo|delivery|deliveryInfo|consignment|consignments|packages|package)$/i.test(k)),carrier==='chezvous'&&(match||matchedOrder)&&(!ownId||match));
    }
  }
  for(const s of findAll(root,n=>n.tag==='script')){
    const type=attr(s,'type').toLowerCase();
    // JSON structuré exposé par la page : pas d'évaluation de JavaScript.
    if(!['application/ld+json','application/json'].includes(type)&&!attr(s,'id').match(/^__NEXT_DATA__$/))continue;
    try{examine(JSON.parse(rawText(s)));}catch{}
  }
  // Attributs de données explicites et liés à un identifiant de colis.
  for(const node of findAll(root,n=>n.tag!=='#text')){
    const parcel=attr(node,'data-tracking-number')||attr(node,'data-parcel-number')||attr(node,'data-shipment-number');
    if(!parcel||!matchingId(parcel,number,carrier))continue;
    const status=attr(node,'data-tracking-status')||attr(node,'data-delivery-status')||attr(node,'data-shipment-status');
    if(status)candidates.push({status,statusRaw:status,statusAt:attr(node,'data-status-at')||null,events:[]});
  }
  return candidates.filter(c=>c.status||c.events.length);
}
function extractSemantic(root,number,carrier){
  // Une page à un seul colis peut exposer un panneau « Statut actuel » ou
  // « État de la livraison ». Le titre d'une FAQ ou une barre d'étapes ne suffit pas.
  const body=nodeText(root);
  const markers=carrier==='dpd'?/(?:Votre colis|N°\s*colis)\s*[:#]?\s*([a-z0-9._-]{6,60})/gi:/(?:num[eé]ro de (?:colis|suivi)|n°\s*(?:de )?colis|votre commande|parcel number|tracking number)\s*[:#]?\s*([a-z0-9._-]{6,60})/gi;
  const ids=[...body.matchAll(markers)].map(m=>m[1]).filter(n=>validNumber(n,carrier));
  if(!ids.some(n=>matchingId(n,number,carrier))||ids.some(n=>!matchingId(n,number,carrier)))return null;
  const results=[];
  for(const node of findAll(root,n=>['dt','th','strong','span','div','p'].includes(n.tag))){
    const label=nodeText(node);
    if(!/^(?:statut actuel|statut de livraison|[eé]tat de la livraison|[eé]tat du colis|current status|delivery status|shipment status)\s*:??$/i.test(label))continue;
    const sibling=node.parent?.children?.[node.parent.children.indexOf(node)+1];
    const value=clean((sibling&&nodeText(sibling))||'');
    if(value&&value.length<250)results.push({status:value,statusRaw:value,events:[]});
  }
  return results.length===1?results[0]:null;
}
// C Chez Vous utilise une référence de COMMANDE, et non nécessairement un
// numéro de colis postal. Seuls les panneaux de suivi du bon dossier sont lus.
function extractChezvous(root,number){
  const heads=findAll(root,n=>/^h[1-6]$/.test(n.tag)&&/^votre commande\s*:/i.test(nodeText(n)));
  const references=heads.map(n=>nodeText(n).match(/^votre commande\s*:\s*([a-z0-9._-]{6,60})/i)?.[1]).filter(Boolean);
  if(references.some(n=>!matchingId(n,number,'chezvous')))throw error('La page C Chez Vous concerne une autre commande.','TRACKING_NUMBER_MISMATCH');
  if(!references.length)return [];
  const ignored=n=>{for(let p=n;p;p=p.parent){
    const cls=fold(attr(p,'class')+' '+attr(p,'id'));
    if(['footer','nav','aside','script','style','template','noscript','details'].includes(p.tag)||/faq|accordion|contact|help|aide|cookie|breadcrumb|progress|stepper/.test(cls)||attr(p,'aria-hidden')==='true'||'hidden' in (p.attrs||{}))return true;
  }return false;};
  const candidates=[];
  const labels=/^(?:statut actuel|statut (?:de |du |de votre )?(?:livraison|colis|suivi)|[eé]tat (?:actuel |de |du |de votre )?(?:livraison|colis)|current status|delivery status|shipment status)\s*:?$/i;
  for(const node of findAll(root,n=>['dt','th','strong','span','div','p','h2','h3','h4','h5','h6'].includes(n.tag)&&!ignored(n))){
    const label=nodeText(node);
    if(!labels.test(label))continue;
    const siblings=node.parent?.children||[];
    const next=siblings[siblings.indexOf(node)+1];
    if(!next||ignored(next))continue;
    const value=nodeText(next);
    // Ne jamais interpréter une section entière, une FAQ ou un libellé
    // prévisionnel comme une remise confirmée.
    if(value&&value.length<=180&&!/\n/.test(text(next))){
      candidates.push({status:value,statusRaw:value,statusAt:attr(next,'data-status-at')||attr(next,'datetime')||null,events:[]});
    }
  }
  // Les composants de suivi peuvent exposer un statut explicite dans leurs
  // attributs. La référence de commande doit être présente sur ce composant.
  for(const node of findAll(root,n=>n.tag!=='#text'&&!ignored(n))){
    const ref=attr(node,'data-order-number')||attr(node,'data-order-reference')||attr(node,'data-tracking-number');
    if(!ref||!matchingId(ref,number,'chezvous'))continue;
    const status=attr(node,'data-delivery-status')||attr(node,'data-tracking-status')||attr(node,'data-shipment-status');
    if(status)candidates.push({status,statusRaw:status,statusAt:attr(node,'data-status-at')||null,events:[]});
  }
  return candidates;
}
function parseTrackingPage(html,{carrier,number,url}){
  if(!PAGE_CARRIERS.has(carrier)||!validNumber(number,carrier))throw error('Suivi non pris en charge.','TRACKING_NOT_CONFIGURED',503);
  if(typeof html!=='string'||html.length>2*1024*1024)throw error('Page de suivi invalide ou trop volumineuse.','TRACKING_PAGE_INVALID');
  const root=parseHtml(html);
  const body=nodeText(root);
  if(/(?:captcha|acc[eè]s prot[eé]g[eé]|code de s[eé]curit[eé]|access denied|request blocked)/i.test(body)&&!/(?:Les étapes de ma livraison|Statut actuel)/i.test(body)){
    throw error('La page demande une vérification ou un accès supplémentaire.','TRACKING_ACCESS_REQUIRED',503);
  }
  const candidates=extractStructured(root,number,carrier);
  if(carrier==='dpd'){
    const dpd=candidates.length?null:extractDpd(root,number);
    if(dpd)candidates.push(dpd);
  }
  const semantic=carrier==='chezvous'?null:extractSemantic(root,number,carrier);if(semantic)candidates.push(semantic);
  if(carrier==='chezvous')candidates.push(...extractChezvous(root,number));
  if(!candidates.length)throw error('Aucun statut de colis exploitable dans la page publique.','TRACKING_PAGE_UNSUPPORTED',503);
  const normalized=candidates.map(c=>{
    const evs=T.eventsOf(c.events||[],carrier);
    const latest=evs[0];
    let status=T.classify(c.status,carrier),raw=statusString(c.statusRaw||c.status),at=T.date(c.statusAt);
    if(latest&&(!raw||status==='inconnu'||(at!=null&&latest.at!=null&&latest.at>at))){status=latest.status;raw=latest.label;at=latest.at;}
    // Si un événement explicite décrit une remise à l'expéditeur, il prévaut
    // sur le libellé générique « livré » du transporteur.
    if(latest?.status==='incident'&&status==='livre'&&/retour|expediteur|sender/i.test(fold(latest.label+' '+(latest.location||'')))){status='incident';raw=latest.label;at=latest.at;}
    return {status,statusRaw:raw,statusAt:at,events:evs};
  }).filter(n=>n.status!=='inconnu'||n.statusRaw);
  if(!normalized.length)throw error('Statut de la page non reconnu.','TRACKING_PAGE_UNSUPPORTED',503);
  const known=normalized.filter(n=>n.status!=='inconnu');
  if(known.length>1&&new Set(known.map(n=>n.status)).size>1){
    const dated=known.filter(n=>n.statusAt!=null).sort((a,b)=>b.statusAt-a.statusAt);
    if(dated.length<2||dated[0].statusAt===dated[1].statusAt)throw error('Plusieurs statuts contradictoires dans la page.','TRACKING_AMBIGUOUS',502);
    normalized.splice(0,normalized.length,dated[0]);
  }
  const selected=normalized.find(n=>n.status!=='inconnu')||normalized[0];
  const result=T.fromCarrierResponse({...selected,statusMethod:'page',sourceUrl:url},carrier,number);
  if(!result||result.status==='inconnu')throw error('Statut de la page non reconnu.','TRACKING_PAGE_UNSUPPORTED',503);
  return {...result,statusMethod:'page',sourceUrl:url};
}

function publicAddress(address){
  const family=net.isIP(address);
  if(family===4){
    const p=address.split('.').map(Number),n=((p[0]*0x1000000)+(p[1]<<16)+(p[2]<<8)+p[3])>>>0;
    const banned=[['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4]];
    return !banned.some(([base,bits])=>{const mask=(0xffffffff<<(32-bits))>>>0;const q=base.split('.').reduce((v,x)=>(v*256+Number(x))>>>0,0);return (n&mask)===(q&mask);});
  }
  if(family===6){
    const a=address.toLowerCase();if(a.startsWith('::ffff:'))return publicAddress(a.slice(7));
    // N'accepter que les adresses globales ordinaires. Rejeter les tunnels
    // IPv4, multicast, documentation, ULA et link-local.
    return /^[23][0-9a-f]{3}:/.test(a)&&!a.startsWith('2001:db8:')&&!a.startsWith('2001:')&&!a.startsWith('2002:');
  }
  return false;
}

function safeLookup(host,options,cb){dns.lookup(host,{...options,all:true},(err,addresses)=>{
  if(err)return cb(err);const allowed=addresses.find(a=>publicAddress(a.address));
  if(!allowed)return cb(error('Adresse réseau du transporteur non autorisée.','TRACKING_URL_NOT_ALLOWED',400));
  cb(null,allowed.address,allowed.family);
});}
function allowBrowserRequest(url,type,method,{carrier,number}){
  let u;try{u=new URL(url);}catch{return false;}
  if(u.protocol!=='https:'||u.username||u.password||u.port&&!['443',''].includes(u.port))return false;
  if(!['GET','HEAD'].includes(method))return false;
  if(type==='Document'){
    try{validatePageUrl(url,carrier,number);return true;}catch{return false;}
  }
  const roots={dpd:['dpd.fr','dpd.com'],gls:['gls-group.com','gls-group.eu','gls-france.com'],chezvous:['cchezvous.fr']}[carrier]||[];
  return roots.some(root=>u.hostname===root||u.hostname.endsWith('.'+root));
}
function createPageTracking({fetch,env=process.env,now=()=>Date.now()}={}){
  if(typeof fetch!=='function')throw new TypeError('fetch requis');
  const enabled=env.TRACKING_PAGE_ENABLED!=='0';
  const browser=createBrowserRenderer({env,allowRequest:allowBrowserRequest,parseResult:parseTrackingPage});
  const browserEnabled=enabled&&env.TRACKING_PAGE_BROWSER==='1'&&browser.configured();
  let browserTail=Promise.resolve();
  const agent=new https.Agent({lookup:safeLookup,keepAlive:true,maxSockets:2,autoSelectFamily:false});
  const robots=new Map(),nextRequestAt=new Map();
  let active=0;const waiting=[];
  const interval=Math.max(1000,Math.min(60000,Number(env.TRACKING_PAGE_INTERVAL_MS)||2000));
  function slot(){if(active<2){active++;return Promise.resolve();}if(waiting.length>=100)throw error('File de suivi saturée.','TRACKING_RATE_LIMITED',429);return new Promise(resolve=>waiting.push(resolve));}
  function release(){if(waiting.length)waiting.shift()();else active--;}
  async function read(url,limit=1024*1024){
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),12000);
    try{
      const r=await fetch(url,{method:'GET',headers:{Accept:'text/html, application/json;q=0.9, */*;q=0.1','User-Agent':'2Kings-SAV-Tracking/1.0'},redirect:'manual',signal:controller.signal,agent});
      if(r.status>=300&&r.status<400)return {redirect:r.headers?.get('location')||'',status:r.status};
      if(r.status===429)throw error('Le transporteur limite les requêtes.','TRACKING_RATE_LIMITED',429);
      if(r.status===401||r.status===403)throw error('Accès public au suivi refusé.','TRACKING_ACCESS_REQUIRED',503);
      if(r.status===404)return {status:404,body:''};
      if(!r.ok)throw error(`Page transporteur indisponible (HTTP ${r.status}).`);
      const length=Number(r.headers?.get('content-length')||0);if(length>limit)throw error('Page de suivi trop volumineuse.','TRACKING_PAGE_INVALID');
      const type=(r.headers?.get('content-type')||'').toLowerCase();
      if(type&&!/text\/(?:html|plain)|application\/(?:json|ld\+json)/.test(type))throw error('Contenu du suivi non exploitable.','TRACKING_PAGE_INVALID');
      let body='';
      if(r.body&&typeof r.body[Symbol.asyncIterator]==='function'){
        let size=0;const decoder=new TextDecoder('utf-8');for await(const chunk of r.body){size+=Buffer.byteLength(chunk);if(size>limit)throw error('Page de suivi trop volumineuse.','TRACKING_PAGE_INVALID');body+=decoder.decode(chunk,{stream:true});}body+=decoder.decode();
      }else{body=await r.text();if(Buffer.byteLength(body)>limit)throw error('Page de suivi trop volumineuse.','TRACKING_PAGE_INVALID');}
      return {status:r.status,body};
    }catch(e){if(e.name==='AbortError')throw error('Délai de lecture de la page dépassé.','TRACKING_TIMEOUT',504);if(e.statusCode)throw e;throw error('Connexion à la page du transporteur impossible.');}
    finally{clearTimeout(timer);}
  }
  function parseRobots(content,path){
    // Règle la plus spécifique, avec * et $ (RFC 9309). Une autorisation
    // explicite l'emporte sur une interdiction de même longueur.
    const groups=[];let agents=[],rules=[],hasRules=false;
    for(const line of String(content).split(/\r?\n/)){
      const m=line.replace(/\s+#.*$/,'').match(/^\s*([\w-]+)\s*:\s*(.*?)\s*$/);if(!m)continue;
      const key=m[1].toLowerCase(),value=m[2];
      if(key==='user-agent'){
        if(hasRules){groups.push({agents,rules});agents=[];rules=[];hasRules=false;}
        agents.push(value.toLowerCase());
      }else if(['allow','disallow'].includes(key)&&agents.length){rules.push({key,value});hasRules=true;}
    }
    if(agents.length)groups.push({agents,rules});
    const specific=groups.filter(g=>g.agents.some(a=>a==='2kings-sav-tracking'));
    const applicable=specific.length?specific:groups.filter(g=>g.agents.includes('*'));
    const matches=applicable.flatMap(g=>g.rules).filter(r=>{
      if(!r.value)return false;
      const source=r.value.endsWith('$')?r.value.slice(0,-1):r.value;
      const pattern='^'+source.split('*').map(x=>x.replace(/[.*+?^${}()|\[\]\\]/g,'\\$&')).join('.*')+(r.value.endsWith('$')?'$':'');
      return new RegExp(pattern).test(path);
    }).sort((a,b)=>b.value.replace(/[*$]/g,'').length-a.value.replace(/[*$]/g,'').length||(a.key==='allow'?-1:1));
    return !matches.length||matches[0].key==='allow';
  }
  async function robotsFor(host){
    let entry=robots.get(host);
    if(entry&&entry.until>=now())return entry.body;
    if(entry?.pending)return entry.pending;
    const pending=(async()=>{
      const r=await read(`${host}/robots.txt`,256*1024);
      if(r.redirect)throw error('Vérification robots.txt redirigée.','TRACKING_ACCESS_REQUIRED',503);
      const body=r.status===404?'':r.body;
      robots.set(host,{body,until:now()+24*3600000});return body;
    })();
    robots.set(host,{pending});
    try{return await pending;}catch(e){robots.delete(host);throw e;}
  }
  async function permitted(url){
    const u=new URL(url);
    if(!parseRobots(await robotsFor(u.origin),u.pathname+u.search))throw error('La page de suivi interdit la lecture automatisée.','TRACKING_ACCESS_REQUIRED',503);
  }
  async function track(carrier,number,url='',options={}){
    if(!enabled||!PAGE_CARRIERS.has(carrier))throw error('Lecture des pages de suivi non activée.','TRACKING_NOT_CONFIGURED',503);
    if(!validNumber(number,carrier))throw error('Numéro de suivi invalide.','INVALID_TRACKING_NUMBER',400);
    const reference=carrier==='chezvous'?(options.reference||number):number;
    if(!validNumber(reference,carrier))throw error('Référence de suivi invalide.','INVALID_TRACKING_NUMBER',400);
    const target=pageUrl(carrier,reference,url);
    await slot();
    try{
      const host=new URL(target).host;
      const start=Math.max(now(),nextRequestAt.get(host)||0);nextRequestAt.set(host,start+interval);
      const delay=Math.max(0,start-now());if(delay)await new Promise(r=>setTimeout(r,delay));
      await permitted(target);
      let current=target;
      for(let i=0;i<3;i++){
        const r=await read(current);
        if(r.redirect){current=validatePageUrl(new URL(r.redirect,current).toString(),carrier,reference);await permitted(current);continue;}
        if(r.status===404)throw error('Numéro introuvable sur la page publique.','TRACKING_NOT_FOUND',503);
        let body=r.body;
        if(/^\s*[\[{]/.test(body))body=`<script type="application/json">${body}</script>`;
        try{const result=parseTrackingPage(body,{carrier,number:reference,url:current});return reference===number?result:{...result,number,orderReference:reference};}
        catch(e){
          if(e.code!=='TRACKING_PAGE_UNSUPPORTED'||!browserEnabled)throw e;
          const task=browserTail.catch(()=>{}).then(()=>browser.render(current,{carrier,number:reference},{permitted}));
          browserTail=task.catch(()=>{});
          const result=await task;return reference===number?result:{...result,number,orderReference:reference};
        }
      }
      throw error('Trop de redirections du transporteur.');
    }finally{release();}
  }
  return {track,configured:c=>enabled&&PAGE_CARRIERS.has(c),browserConfigured:()=>browserEnabled,supported:PAGE_CARRIERS,validatePageUrl,canonicalUrl};
}
module.exports={createPageTracking,parseTrackingPage,validatePageUrl,canonicalUrl,matchingId,parseHtml,publicAddress,allowBrowserRequest};
