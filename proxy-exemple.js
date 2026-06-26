/**
 * Proxy backend — Centre de réclamations Marketplaces (multi-adaptateurs)
 * =======================================================================
 * Relaie les appels de la page web vers l'API de CHAQUE marketplace, en
 * gardant les identifiants SECRETS côté serveur (jamais dans le navigateur).
 *
 * Chaque marketplace a sa propre technologie d'API -> un ADAPTATEUR par
 * technologie. Tous renvoient le même format "claim".
 *
 *   - octopia : Cdiscount, et aussi Rakuten, Alltricks, OnBuy, CDON, Joom,
 *               Fyndiq, Kingfisher (Castorama/Brico Dépôt) — réseau Octopia.
 *               ✅ ENDPOINTS RÉELS RENSEIGNÉS (API Discussions v2).
 *   - mirakl  : Carrefour, Leroy Merlin, Boulanger, Leclerc, But, Cultura,
 *               Conforama, Ubaldi, Rue du Commerce, Castorama, Auchan (API unifiée).
 *               ✅ endpoints publics connus.
 *   - bomp    : Fnac + Darty (Back Office Marketplace Fnac Darty, ex-Mirakl).
 *               ⚠ endpoints à compléter avec la doc Fnac Darty.
 *
 *   npm install      (puis)   npm start
 *   Variables d'identifiants : fichier .env (voir .env.example)
 * --------------------------------------------------------------------- */
require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');
const fetch = (...a) => import('node-fetch').then(({ default: f }) => f(...a));
// Pour l'adaptateur BOMP (Fnac/Darty), l'API est en XML : fast-xml-parser
const { XMLParser, XMLBuilder } = require('fast-xml-parser');

const app = express();
// Autorise la page (sur votre domaine) à appeler ce proxy. Restreignez via ALLOWED_ORIGIN.
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Sert aussi le tableau de bord : ouvrez http://localhost:8787
app.use(express.static(__dirname));

const H = 3600 * 1000;

/* =====================================================================
   1) DÉCLARATION DES FOURNISSEURS
   Chaque fournisseur a un "type" (= adaptateur) et sa propre config.
   =====================================================================*/
const PROVIDERS = [
  {
    type: 'octopia',
    label: 'Octopia',
    auth: {
      tokenUrl: 'https://auth.octopia-io.net/auth/realms/maas/protocol/openid-connect/token',
      apiBase: (process.env.OCTOPIA_API_BASE || 'https://api.octopia-io.net/seller/v2').replace(/\/+$/, ''),
      clientId: process.env.OCTOPIA_CLIENT_ID,
      clientSecret: process.env.OCTOPIA_CLIENT_SECRET,
      sellerId: process.env.OCTOPIA_SELLER_ID,
    },
    // Mappe le code "salesChannel" Octopia -> code marketplace affiché dans la page.
    // (un seul compte Octopia peut couvrir plusieurs canaux)
    channelMap: {
      CDISFR: 'cdiscount',
      // Ajoutez ici d'autres canaux du même compte Octopia si besoin.
    },
  },
  // --- Marketplaces Mirakl (une ligne par opérateur, même adaptateur) ---
  { type: 'mirakl', code: 'carrefour', label: 'Carrefour', url: process.env.CARREFOUR_URL, key: process.env.CARREFOUR_KEY },
  { type: 'mirakl', code: 'leroymerlin', label: 'Leroy Merlin', url: process.env.LEROYMERLIN_URL, key: process.env.LEROYMERLIN_KEY },
  { type: 'mirakl', code: 'boulanger', label: 'Boulanger', url: process.env.BOULANGER_URL, key: process.env.BOULANGER_KEY },
  { type: 'mirakl', code: 'leclerc', label: 'E.Leclerc', url: process.env.LECLERC_URL, key: process.env.LECLERC_KEY },
  { type: 'mirakl', code: 'but', label: 'But', url: process.env.BUT_URL, key: process.env.BUT_KEY },
  { type: 'mirakl', code: 'cultura', label: 'Cultura', url: process.env.CULTURA_URL, key: process.env.CULTURA_KEY },
  { type: 'mirakl', code: 'conforama', label: 'Conforama', url: process.env.CONFORAMA_URL, key: process.env.CONFORAMA_KEY },
  { type: 'mirakl', code: 'ubaldi', label: 'Ubaldi', url: process.env.UBALDI_URL, key: process.env.UBALDI_KEY },
  { type: 'mirakl', code: 'rueducommerce', label: 'Rue du Commerce', url: process.env.RUEDUCOMMERCE_URL, key: process.env.RUEDUCOMMERCE_KEY },
  { type: 'mirakl', code: 'castorama', label: 'Castorama', url: process.env.CASTORAMA_URL, key: process.env.CASTORAMA_KEY },
  { type: 'mirakl', code: 'auchan', label: 'Auchan', url: process.env.AUCHAN_URL, key: process.env.AUCHAN_KEY },
  // --- Fnac / Darty (BOMP) — API Marketplace Fnac historique, en XML ---
  // Auth = partnerId + shopId + key. Clé API distincte par boutique, partnerId commun.
  {
    type: 'bomp', code: 'fnac', label: 'Fnac', apiBase: process.env.FNAC_API_BASE || 'https://vendeur.fnac.com/api.php',
    partnerId: process.env.FNAC_PARTNER_ID, shopId: process.env.FNAC_SHOP_ID, key: process.env.FNAC_KEY
  },
  {
    type: 'bomp', code: 'darty', label: 'Darty', apiBase: process.env.DARTY_API_BASE || process.env.FNAC_API_BASE || 'https://vendeur.fnac.com/api.php',
    partnerId: process.env.DARTY_PARTNER_ID, shopId: process.env.DARTY_SHOP_ID, key: process.env.DARTY_KEY
  },
];

/* =====================================================================
   2) HELPERS COMMUNS
   =====================================================================*/
function computeDueAt(messages) {
  const lastClient = [...messages].reverse().find(m => m.from === 'client');
  return (lastClient ? lastClient.at : Date.now()) + 24 * H;   // SLA 24 h, à adapter
}
function makeClaim(marketplace, o = {}) {
  const messages = normalizeClaimMessages(o.messages || []);
  const messageTimes = messages.map(m => Number(m.at || 0)).filter(Number.isFinite).filter(Boolean);
  const firstMessageAt = messageTimes.length ? Math.min(...messageTimes) : 0;
  const lastMessageAt = messageTimes.length ? Math.max(...messageTimes) : 0;
  const lastClientMessageAt = messages.filter(m => m.from === 'client').map(m => Number(m.at || 0)).filter(Number.isFinite).filter(Boolean).sort((a, b) => b - a)[0] || 0;
  const claimCreatedAt = parseMarketplaceDate(scalarFirst(o.createdAt, o.claimCreatedAt, o.openedAt, o.created_at, o.dateCreated), firstMessageAt || o.updatedAt || Date.now());
  const claimLastMessageAt = parseMarketplaceDate(scalarFirst(o.lastMessageAt, o.last_message_at, o.lastMessageDate, o.rawUpdatedAt), lastMessageAt || o.updatedAt || claimCreatedAt);
  const rawMarketplaceStatus = scalarFirst(
    o.marketplaceStatus,
    o.marketplaceStatusLabel,
    o.marketplaceStatusCode,
    o.rawStatus,
    o.statusRaw,
    o.ctx?.marketplaceStatus,
    o.ctx?.rawStatus
  );
  const normalizedStatus = rawMarketplaceStatus && isClosedMarketplaceStatus(rawMarketplaceStatus)
    ? 'resolu'
    : (o.status || normalizeMarketplaceStatus(rawMarketplaceStatus, 'nouveau'));
  const ctx = {
    ...(o.ctx || {}),
    ...(rawMarketplaceStatus ? { marketplaceStatus: rawMarketplaceStatus, rawStatus: rawMarketplaceStatus } : {}),
  };
  if (rawMarketplaceStatus && isClosedMarketplaceStatus(rawMarketplaceStatus)) ctx.closedByMarketplace = true;

  return {
    id: `${marketplace}:${o.providerType}:${o.id}`,   // route la réponse vers le bon adaptateur
    marketplace,
    customer: sanitizeCustomerName(o.customer) || 'Client',
    customerId: o.customerId || '',
    subject: o.subject || 'Réclamation',
    orderId: o.orderId || '',
    product: o.product || '',
    ean: firstOrderEan(o.ean, o.gtin, o.productEan, o.productEAN, o.product_ean, o.product_gtin, o.product_reference, o.productReference, o.barcode, o.gencod, o.ctx),
    priority: o.priority || 'moyenne',
    // Statut normalisé pour l'IHM + statut brut marketplace pour l'affichage fidèle.
    status: normalizedStatus,
    marketplaceStatus: rawMarketplaceStatus || normalizedStatus,
    statusRaw: rawMarketplaceStatus || normalizedStatus,
    updatedAt: o.updatedAt || claimLastMessageAt || Date.now(),
    createdAt: claimCreatedAt,
    claimCreatedAt,
    lastMessageAt: claimLastMessageAt,
    lastClientMessageAt: lastClientMessageAt || null,
    dueAt: o.dueAt || computeDueAt(messages),
    messages,
    tracking: normalizeTracking(o.tracking, o),
    _ctx: ctx,                                      // données techniques utiles à la réponse
  };
}

function inferCarrierFromTrackingUrl(rawUrl = '') {
  const u = foldStatusText(rawUrl);
  if (!u) return '';
  // URLs parasites fréquentes dans les messages Fnac/Darty : enquêtes de satisfaction, avis, NPS, formulaires.
  // Elles contiennent parfois un identifiant qui ressemble à un suivi : on les refuse toujours.
  if (/(satisfaction|survey|enquete|questionnaire|feedback|avis|review|evaluation|evaluer|rating|nps|csat|trustpilot|avis[-_ ]?verifies|netreviews|ekomi|bazaarvoice|qualtrics|medallia|forms\.office|docs\.google\.com\/forms|google\.com\/forms)/.test(u)) return '';
  if (/laposte|la-poste|colissimo|suivre-vos-envois|suivi\.laposte|outils\/suivre/.test(u)) return 'colissimo';
  if (/chronopost|chrono-post|tracking-no-cms|chrono_suivi|listeNumerosLT/i.test(rawUrl)) return 'chronopost';
  if (/\bdpd\b|trace\.dpd|dpdgroup|predict\.dpd/.test(u)) return 'dpd';
  if (/gls-group|glsfr|gls-france|glsfrance|\bgls\b/.test(u)) return 'gls';
  if (/\bups\b|united parcel|ups\.com\/track/.test(u)) return 'ups';
  if (/\bdhl\b|dhlparcel|dhl\.com/.test(u)) return 'dhl';
  if (/fedex|federal express|fedextrack/.test(u)) return 'fedex';
  if (/\btnt\b|tnt\.com|tnt\.fr/.test(u)) return 'tnt';
  if (/mondialrelay|mondial-relay|mondial relay/.test(u)) return 'mondialrelay';
  if (/relaiscolis|relais-colis|relais colis/.test(u)) return 'relaiscolis';
  if (/colisprive|colis-prive|colis prive/.test(u)) return 'colisprive';
  if (/cchezvous|c-chez-vous|c chez vous|chezvous/.test(u)) return 'chezvous';
  if (/geodis|calberson/.test(u)) return 'geodis';
  return '';
}

function isLikelyTrackingUrl(rawUrl = '') {
  const url = cleanText(rawUrl);
  if (!/^https?:\/\//i.test(url)) return false;
  const u = foldStatusText(url);
  if (/(satisfaction|survey|enquete|questionnaire|feedback|avis|review|evaluation|evaluer|rating|nps|csat|trustpilot|avis[-_ ]?verifies|netreviews|ekomi|bazaarvoice|qualtrics|medallia|forms\.office|docs\.google\.com\/forms|google\.com\/forms)/.test(u)) return false;
  // On accepte les URLs des transporteurs connus, ou une vraie URL dont le chemin annonce clairement du suivi.
  return Boolean(inferCarrierFromTrackingUrl(url) || /(tracking|track|trace|suivi|colis|parcel|shipment|expedition|consignment|skybill|waybill)/.test(u));
}

function safeTrackingUrl(rawUrl = '') {
  const url = cleanText(rawUrl);
  return isLikelyTrackingUrl(url) ? url : '';
}

function normalizeCarrierCode(raw, number = '', url = '') {
  const s = foldStatusText(raw);
  if (/colissimo|la poste|laposte|courrier suivi/.test(s)) return 'colissimo';
  if (/chrono|chronopost/.test(s)) return 'chronopost';
  if (/\bdpd\b|dpd predict/.test(s)) return 'dpd';
  if (/\bgls\b/.test(s)) return 'gls';
  if (/\bups\b/.test(s)) return 'ups';
  if (/\bdhl\b/.test(s)) return 'dhl';
  if (/fedex|federal express/.test(s)) return 'fedex';
  if (/\btnt\b/.test(s)) return 'tnt';
  if (/mondial|relay/.test(s)) return 'mondialrelay';
  if (/relais colis|relaiscolis/.test(s)) return 'relaiscolis';
  if (/colis prive|colispriv/.test(s)) return 'colisprive';
  if (/chezvous|chez vous|cchezvous|c chez vous/.test(s)) return 'chezvous';
  if (/geodis|calberson/.test(s)) return 'geodis';

  const fromUrl = inferCarrierFromTrackingUrl(url);
  if (fromUrl) return fromUrl;

  const n = String(number || '').replace(/\s+/g, '').toUpperCase();
  if (/^1Z[A-Z0-9]{10,}$/.test(n)) return 'ups';
  if (/^(?:6[A-Z0-9]{10,}|8[A-Z0-9]{10,}|7[A-Z0-9]{10,}|[A-Z]{2}\d{9}FR)$/.test(n)) return 'colissimo';
  if (/^(?:XY|XU|XX|XT|XS|XA|XP)[A-Z0-9]{8,}FR$/.test(n)) return 'chronopost';
  if (/^[A-Z]{2}\d{8,}[A-Z]{2}$/.test(n)) return 'chronopost';
  if (/^GEODIS/i.test(n)) return 'geodis';

  // Important : ne jamais transformer un ID, une URL ou un libellé inconnu en nom de transporteur.
  // Si ce n'est pas reconnu, l'IHM affichera simplement "Transporteur".
  return '';
}

function normalizeTrackingStatus(raw, events = []) {
  const all = [raw, ...(events || []).map(e => e?.label)].filter(Boolean).join(' ');
  const s = foldStatusText(all);
  // Important : un simple numéro de suivi ne veut PAS dire que le colis est en transit.
  // On ne classe en transit que si la marketplace/le transporteur donne un vrai statut ou événement exploitable.
  if (!s) return 'inconnu';
  if (/livr|delivered|remis/.test(s)) return 'livre';
  if (/point relais|relais|pickup|a retirer|consigne|disponible/.test(s)) return 'pret_retrait';
  if (/incident|echec|absent|retour|refus|exception|probleme|anomalie|perdu/.test(s)) return 'incident';
  if (/preparation|etiquette|label|enregistr|created|annonce|attente|pending/.test(s)) return 'en_attente';
  if (/expedi|expedie|shipped|pris en charge|accepted|collected|achemin|transit|hub|tri|route|en cours de livraison|out for delivery|en livraison|depart|arrive/.test(s)) return 'en_transit';
  return 'inconnu';
}

function trackingStatusRank(status) {
  const s = String(status || '').toLowerCase();
  if (['livre', 'incident', 'pret_retrait'].includes(s)) return 4;
  if (s === 'en_attente') return 3;
  if (s === 'en_transit') return 2;
  if (s === 'inconnu') return 1;
  return 0;
}
function chooseTrackingStatus(...statuses) {
  return statuses.filter(Boolean).sort((a, b) => trackingStatusRank(b) - trackingStatusRank(a))[0] || 'inconnu';
}

function looksLikeTrackingNumber(v) {
  const s = cleanText(v).replace(/\s+/g, '');
  if (!s || s.length < 6 || s.length > 60) return false;
  if (/^https?:/i.test(s)) return false;
  if (!/[0-9]/.test(s)) return false;
  if (/[@]/.test(s)) return false;
  return /^[A-Z0-9._\-]+$/i.test(s);
}

function firstDeepValue(obj, keyRegex, maxDepth = 5) {
  const seen = new Set();
  function walk(v, depth) {
    if (v == null || depth > maxDepth) return '';
    if (typeof v !== 'object') return '';
    if (seen.has(v)) return '';
    seen.add(v);
    if (Array.isArray(v)) {
      for (const item of v) {
        const got = walk(item, depth + 1);
        if (got) return got;
      }
      return '';
    }
    for (const [k, val] of Object.entries(v)) {
      if (keyRegex.test(k)) {
        const got = scalarValue(val);
        if (got) return got;
      }
    }
    for (const val of Object.values(v)) {
      const got = walk(val, depth + 1);
      if (got) return got;
    }
    return '';
  }
  return walk(obj, 0);
}

function collectDeepArrays(obj, keyRegex, maxDepth = 5) {
  const out = [];
  const seen = new Set();
  function walk(v, depth, key = '') {
    if (v == null || depth > maxDepth || typeof v !== 'object') return;
    if (seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) {
      if (keyRegex.test(key)) out.push(v);
      v.forEach(item => walk(item, depth + 1));
      return;
    }
    for (const [k, val] of Object.entries(v)) walk(val, depth + 1, k);
  }
  walk(obj, 0);
  return out;
}

function normalizeTrackingEvent(e) {
  if (!e) return null;
  if (typeof e === 'string') return { at: Date.now(), label: cleanText(e) };
  const label = cleanText(scalarFirst(e.label, e.description, e.status, e.eventLabel, e.event_label, e.message, e.libelle, e.libellé, e.activity));
  const atRaw = scalarFirst(e.at, e.date, e.eventDate, e.event_date, e.timestamp, e.time, e.datetime, e.created_at);
  const at = atRaw ? parseMarketplaceDate(atRaw, Date.now()) : (e.h != null ? Date.now() - Number(e.h) * H : Date.now());
  if (!label) return null;
  return { at, label };
}

function normalizeTracking(raw, source = {}) {
  const root = raw || source || {};
  if (!root) return null;
  if (typeof root === 'string') {
    return looksLikeTrackingNumber(root) ? { carrier: normalizeCarrierCode('', root) || 'transporteur', number: cleanText(root), status: 'inconnu', etaH: null, events: [] } : null;
  }

  const number = scalarFirst(
    root.number, root.trackingNumber, root.tracking_number, root.trackingCode, root.tracking_code, root.trackingId, root.tracking_id,
    root.parcelNumber, root.parcel_number, root.shipmentNumber, root.shipment_number, root.shipping_number, root.awb, root.waybill,
    firstDeepValue(root, /^(tracking_?number|tracking_?code|tracking_?id|parcel_?number|shipment_?number|shipping_?number|awb|waybill|tracking)$/i)
  );

  let trackingNumber = cleanText(number);
  if (!looksLikeTrackingNumber(trackingNumber)) {
    const url = safeTrackingUrl(scalarFirst(root.url, root.trackingUrl, root.tracking_url, firstDeepValue(root, /(tracking|shipment|parcel).*url|url.*tracking/i)));
    const m = String(url || '').match(/[?&](?:code|tracking-id|trackingNumber|tracking_number|tracknum|listeNumerosLT|match|numColis|numeroExpedition|cons)=([^&]+)/i);
    trackingNumber = m ? decodeURIComponent(m[1]) : '';
  }
  if (!looksLikeTrackingNumber(trackingNumber)) return null;

  const url = safeTrackingUrl(scalarFirst(
    root.url, root.trackingUrl, root.tracking_url, root.shippingTrackingUrl, root.shipping_tracking_url,
    firstDeepValue(root, /(tracking|shipment|parcel|shipping).*url|url.*tracking/i)
  ));
  const carrierRaw = scalarFirst(
    root.carrier, root.carrierCode, root.carrier_code, root.carrierName, root.carrier_name, root.transporteur, root.transporter,
    root.shippingCarrier, root.shipping_carrier, root.shippingCompany, root.shipping_company, root.delivery_carrier,
    root.shippingTypeLabel, root.shipping_type_label, root.shippingTypeCode, root.shipping_type_code,
    firstDeepValue(root, /^(carrier|carrier_?code|carrier_?name|transporteur|transporter|shipping_?carrier|shipping_?company|delivery_?carrier|shipping_?type_?(label|code))$/i)
  );
  let events = [];
  for (const arr of collectDeepArrays(root, /(event|history|tracking|shipment).*s?$/i, 4)) {
    events.push(...arr.map(normalizeTrackingEvent).filter(Boolean));
  }
  events = dedupeTrackingEvents(events).slice(0, 20);
  const statusRaw = scalarFirst(root.status, root.tracking_status, root.delivery_status, root.shipment_status, firstDeepValue(root, /(tracking|delivery|shipment).*status|^status$/i));

  return {
    carrier: normalizeCarrierCode(carrierRaw, trackingNumber, url) || 'transporteur',
    number: trackingNumber,
    status: normalizeTrackingStatus(statusRaw, events),
    etaH: root.etaH ?? root.eta ?? null,
    events,
    ...(url ? { url: cleanText(url) } : {}),
  };
}

function mergeTrackingInfo(current, extra) {
  const a = normalizeTracking(current);
  const b = normalizeTracking(extra);
  if (!a) return b;
  if (!b) return a;
  const events = dedupeTrackingEvents([...(a.events || []), ...(b.events || [])]).slice(0, 20);
  return {
    carrier: (a.carrier && a.carrier !== 'transporteur') ? a.carrier : b.carrier,
    number: a.number || b.number,
    status: chooseTrackingStatus(normalizeTrackingStatus('', events), a.status, b.status),
    etaH: a.etaH ?? b.etaH ?? null,
    events,
    ...(a.url || b.url ? { url: a.url || b.url } : {}),
  };
}

function normalizeOrderTracking(order = {}) {
  const candidates = [];
  const addCandidate = (src = {}, fallback = {}) => {
    if (!src || typeof src !== 'object') return;
    const t = normalizeTracking({
      number: scalarFirst(
        src.shipping_tracking, src.shippingTracking, src.shipping_tracking_number, src.shippingTrackingNumber,
        src.tracking_number, src.trackingNumber, src.tracking_code, src.trackingCode, src.tracking_id, src.trackingId,
        src.parcel_number, src.parcelNumber, src.package_number, src.packageNumber, src.shipment_number, src.shipmentNumber,
        src.awb, src.waybill, typeof src.tracking === 'string' ? src.tracking : '', fallback.number
      ),
      url: scalarFirst(src.shipping_tracking_url, src.shippingTrackingUrl, src.tracking_url, src.trackingUrl, src.url, fallback.url),
      carrier: scalarFirst(
        src.shipping_carrier, src.shippingCarrier, src.shipping_carrier_code, src.shippingCarrierCode,
        src.carrier, src.carrier_code, src.carrierCode, src.carrier_name, src.carrierName,
        src.transporteur, src.transporter, src.shipping_type_label, src.shippingTypeLabel,
        src.shipping_type_code, src.shippingTypeCode, src.delivery_carrier, fallback.carrier
      ),
      status: scalarFirst(src.shipping_status, src.delivery_status, src.shipment_status, src.tracking_status, src.status, fallback.status),
      events: src.events || src.history || src.tracking_events || fallback.events,
    }, src);
    if (t) candidates.push(t);
  };

  addCandidate(order);
  for (const key of ['shipping', 'shipment', 'delivery', 'tracking', 'logistic', 'logistics', 'parcel', 'package']) {
    if (order[key] && typeof order[key] === 'object') addCandidate(order[key], order);
  }
  for (const key of ['shipments', 'parcels', 'packages', 'order_lines', 'orderLines', 'lines', 'items', 'fulfillments', 'consignments']) {
    const arr = Array.isArray(order[key]) ? order[key] : (order[key] ? [order[key]] : []);
    for (const item of arr) {
      addCandidate(item, order);
      for (const nested of ['shipping', 'shipment', 'delivery', 'tracking', 'parcel', 'package']) {
        if (item && item[nested] && typeof item[nested] === 'object') addCandidate(item[nested], item);
      }
    }
  }
  for (const arr of collectDeepArrays(order, /(shipment|parcel|package|tracking|delivery|logistic|carrier)s?$/i, 6)) {
    for (const item of arr) addCandidate(item, order);
  }

  return candidates.find(t => t.carrier && t.carrier !== 'transporteur') || candidates[0] || null;
}

function dedupeTrackingEvents(events) {
  const seen = new Set();
  return (events || []).filter(e => {
    const key = `${e.at}|${e.label}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => Number(b.at || 0) - Number(a.at || 0));
}

function normalizeRatingValue(raw) {
  const s = scalarValue(raw).replace(',', '.');
  const m = s.match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  if (!Number.isFinite(n) || n <= 0) return null;
  // Certaines APIs renvoient 10/20/100 ; on ramène tout sur 5 étoiles.
  if (n > 20) return Math.max(1, Math.min(5, Math.round((n / 100) * 5)));
  if (n > 5 && n <= 10) return Math.max(1, Math.min(5, Math.round(n / 2)));
  if (n > 10 && n <= 20) return Math.max(1, Math.min(5, Math.round(n / 4)));
  return Math.max(1, Math.min(5, Math.round(n)));
}

function makeProductNote(marketplace, o = {}) {
  const rating = normalizeRatingValue(o.rating ?? o.rate ?? o.score ?? o.grade ?? o.stars);
  const idBase = scalarFirst(o.id, o.commentId, o.evaluationId, o.orderId, o.ean, o.product, Date.now());
  return {
    id: `${marketplace}:note:${idBase}`,
    marketplace,
    orderId: scalarFirst(o.orderId, o.order_id, o.orderFnacId, o.orderReference),
    customer: cleanText(scalarFirst(o.customer, o.customerName, o.buyer, o.client)) || 'Client',
    product: cleanText(scalarFirst(o.product, o.productName, o.product_title, o.title, o.offerSellerId, o.sku)),
    ean: cleanText(scalarFirst(o.ean, o.gtin, o.product_reference, o.productReference, o.offerSellerId, o.sellerSku)),
    rating,
    visible: o.visible !== false,
    comment: cleanText(scalarFirst(o.comment, o.review, o.body, o.text, o.message, o.description)),
    at: parseMarketplaceDate(scalarFirst(o.at, o.createdAt, o.updatedAt, o.date), Date.now()),
    reply: cleanText(scalarFirst(o.reply, o.sellerReply, o.answer, o.seller_answer)),
    repliedBy: cleanText(scalarFirst(o.repliedBy, o.agent, o.seller, o.author)),
    source: cleanText(scalarFirst(o.source, o.providerType, 'api')),
    _ctx: o.ctx || {},
  };
}

function productNoteIsUsable(n) {
  return Boolean(n && n.rating && (n.comment || n.orderId || n.product || n.ean));
}

function dedupeProductNotes(notes) {
  const seen = new Set();
  return (notes || []).filter(n => {
    if (!productNoteIsUsable(n)) return false;
    const key = [n.marketplace, n.orderId, n.ean, n.rating, n.comment, n.at].map(v => String(v || '').toLowerCase()).join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function scalarValue(v) {
  if (v === 0) return '0';
  if (v === undefined || v === null) return '';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v).trim();
  if (Array.isArray(v)) {
    for (const item of v) {
      const got = scalarValue(item);
      if (got) return got;
    }
    return '';
  }
  if (typeof v === 'object') {
    for (const key of ['id', 'value', 'identifier', 'code', 'reference', 'order_id', 'orderId', 'message_id', 'thread_id', 'threadId', 'discussionId', 'href']) {
      const got = scalarValue(v[key]);
      if (got) return got;
    }
    const text = scalarValue(v['#text']);
    if (text) return text;
  }
  return '';
}
function scalarFirst(...values) {
  for (const v of values) {
    const got = scalarValue(v);
    if (got) return got;
  }
  return '';
}
function publicErrorPayload(e, fallbackStatus = 502) {
  return {
    error: e?.message || 'Erreur inconnue',
    status: Number(e?.statusCode || e?.status || fallbackStatus),
    provider: e?.provider || null,
    operation: e?.operation || null,
  };
}
function parseMarketplaceDate(raw, fallback = Date.now()) {
  if (raw == null || raw === '') {
    return fallback;
  }

  // timestamp numérique (ms ou secondes)
  if (
    typeof raw === 'number' ||
    /^\d+$/.test(String(raw))
  ) {
    const n = Number(raw);

    const ms =
      String(Math.abs(n)).length >= 13
        ? n
        : n * 1000;

    return Number.isFinite(ms)
      ? ms
      : fallback;
  }

  const t = new Date(raw).getTime();

  if (Number.isNaN(t)) {
    console.warn('[date] Date invalide reçue :', raw);
    return fallback;
  }

  return t;
}

function decodeHtmlEntities(v) {
  let s = String(v ?? '');
  if (!s) return '';
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', euro: '€' };
  for (let i = 0; i < 3; i++) {
    const before = s;
    s = s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);/gi, (m, code) => {
      const c = String(code || '').toLowerCase();
      if (c[0] === '#') {
        const n = c[1] === 'x' ? parseInt(c.slice(2), 16) : parseInt(c.slice(1), 10);
        return Number.isFinite(n) ? String.fromCodePoint(n) : m;
      }
      return Object.prototype.hasOwnProperty.call(named, c) ? named[c] : m;
    });
    if (s === before) break;
  }
  return s;
}

function htmlToPlainText(v, { preserveBreaks = false } = {}) {
  let s = decodeHtmlEntities(v);
  if (!s) return '';
  s = s.replace(/<\s*(script|style)[^>]*>[\s\S]*?<\/\s*\1\s*>/gi, ' ');
  s = s.replace(/<\s*br\s*\/?\s*>/gi, preserveBreaks ? '\n' : ' ');
  s = s.replace(/<\s*\/(p|div|li|tr|h[1-6])\s*>/gi, preserveBreaks ? '\n' : ' ');
  s = s.replace(/<\s*(p|div|li|tr|h[1-6])(?:\s[^>]*)?>/gi, preserveBreaks ? '\n' : ' ');
  s = s.replace(/<[^>]+>/g, ' ');
  s = s.replace(/\r/g, '');
  if (preserveBreaks) {
    return s
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
  }
  return s.replace(/\s+/g, ' ').trim();
}

function cleanText(v) {
  return htmlToPlainText(v, { preserveBreaks: false });
}

function cleanMessageText(v) {
  return htmlToPlainText(v, { preserveBreaks: true });
}

function normalizeClaimMessage(m) {
  const obj = (m && typeof m === 'object') ? m : { text: m };
  const fromRaw = cleanText(obj.from || obj.sender_type || obj.author_type || 'client').toLowerCase();
  const from = ['client', 'seller', 'system'].includes(fromRaw) ? fromRaw : fromRaw.includes('sell') || fromRaw.includes('shop') ? 'seller' : fromRaw.includes('system') ? 'system' : 'client';
  return {
    ...obj,
    from,
    author: cleanText(obj.author || obj.sender || obj.user || ''),
    text: cleanMessageText(obj.text ?? obj.body ?? obj.message ?? obj.content ?? obj.description ?? ''),
    attachments: Array.isArray(obj.attachments) ? obj.attachments : [],
  };
}

function normalizeClaimMessages(messages) {
  return asArray(messages).map(normalizeClaimMessage).filter(m => m.text || (m.attachments && m.attachments.length));
}

function asArray(v) {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

function safeHeaderFilename(name) {
  const s = cleanText(name || 'piece-jointe')
    .replace(/[\r\n"]/g, '')
    .slice(0, 180);
  return s || 'piece-jointe';
}


function attachmentKeyNorm(k) {
  return String(k || '').replace(/^@_/, '').replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function looksLikeAttachmentFilename(v) {
  const s = cleanText(v);
  if (!s) return false;
  if (/^https?:\/\//i.test(s) || /[\\/]/.test(s)) return true;
  if (/\.(?:pdf|png|jpe?g|gif|webp|heic|bmp|tiff?|docx?|xlsx?|xls|pptx?|zip|rar|7z|txt|csv|json|xml|eml|msg|mp4|mov|avi|mkv|webm|wav|mp3)$/i.test(s)) return true;
  if (/^(?:img|image|photo|screenshot|capture|scan|piece|pi[eè]ce|pj|attachment|file|document)[-_\s]?\d+/i.test(s)) return true;
  return false;
}

function isBadCustomerName(v) {
  const s = cleanText(v);
  if (!s) return true;
  if (looksLikeAttachmentFilename(s)) return true;
  if (/^(?:CLIENT|CUSTOMER|SELLER|SHOP|SYSTEM|CALLCENTER|FNAC|DARTY|ORDER|MESSAGE)$/i.test(s)) return true;
  if (/^https?:\/\//i.test(s) || /[\\/]/.test(s)) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return true;
  if (/^\d+(?:\.\w+)?$/.test(s)) return true;
  return false;
}

function sanitizeCustomerName(v) {
  const s = cleanText(v);
  return isBadCustomerName(s) ? '' : s;
}

function looksLikeEan(v) {
  const s = cleanText(v).replace(/\D/g, '');
  return /^(?:\d{8}|\d{12,14})$/.test(s) ? s : '';
}


function collectDeepEans(obj, out = [], seen = new Set(), depth = 0) {
  if (!obj || depth > 6) return out;
  if (typeof obj === 'string' || typeof obj === 'number') {
    const got = looksLikeEan(obj);
    if (got) out.push(got);
    return out;
  }
  if (typeof obj !== 'object') return out;
  if (seen.has(obj)) return out;
  seen.add(obj);
  if (Array.isArray(obj)) {
    for (const item of obj) collectDeepEans(item, out, seen, depth + 1);
    return out;
  }
  const keyRx = /^(ean|gtin|gencod|barcode|bar_code|code_barre|product_?ean|product_?gtin|product_?barcode|product_?reference|productReference)$/i;
  for (const [k, v] of Object.entries(obj)) {
    if (keyRx.test(k)) {
      const got = looksLikeEan(v);
      if (got) out.push(got);
    }
  }
  for (const [k, v] of Object.entries(obj)) {
    if (/(product|produit|offer|article|item|line|ligne|order_line|orderLines|entities|entity)/i.test(k)) {
      collectDeepEans(v, out, seen, depth + 1);
    }
  }
  return out;
}
function firstOrderEan(...sources) {
  for (const source of sources) {
    const direct = looksLikeEan(source);
    if (direct) return direct;
    const found = collectDeepEans(source).find(Boolean);
    if (found) return found;
  }
  return '';
}

function fullNameFromPieces(...parts) {
  const out = parts.map(cleanText).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  return sanitizeCustomerName(out);
}

const ATTACHMENT_CONTAINER_KEYS = new Set([
  'attachment', 'attachments', 'attachmentlist', 'attachmentfile', 'attachmentfiles',
  'file', 'files', 'filelist', 'document', 'documents', 'documentlist',
  'piecejointe', 'piecesjointes', 'pj', 'pjs'
]);

function collectAttachmentCandidates(source, out = [], seen = new Set(), hint = false) {
  if (!source) return out;
  if (typeof source === 'string') {
    if (hint && (/^https?:\/\//i.test(source) || source.startsWith('/'))) out.push(source);
    return out;
  }
  if (typeof source !== 'object' || seen.has(source)) return out;
  seen.add(source);

  if (Array.isArray(source)) {
    source.forEach(v => collectAttachmentCandidates(v, out, seen, hint));
    return out;
  }

  const rawName = scalarFirst(
    source.name, source.file_name, source.filename, source.fileName, source.label, source.title,
    source.originalname, source.document_name, source.documentName, source.display_name,
    source['#text'], source['@_name'], source['@_filename'], source['@_file_name']
  );
  const sourceUrl = attachmentSourceUrl(source);
  const sourceId = attachmentSourceId(source);
  const sizeRaw = scalarFirst(source.size, source.file_size, source.fileSize, source.length, source.content_length, source.contentLength, source['@_size']);
  const typeRaw = scalarFirst(source.mimeType, source.mimetype, source.mime_type, source.content_type, source.contentType, source.type, source['@_mime_type'], source['@_content_type']);
  const nameLooksFile = looksLikeAttachmentFilename(rawName);
  const hasFileSignal = Boolean(sourceUrl || sizeRaw || typeRaw || nameLooksFile);

  if ((hint || nameLooksFile || sourceUrl || typeRaw || sizeRaw) && hasFileSignal && (rawName || sourceUrl || sourceId)) {
    out.push(source);
  }

  for (const [k, v] of Object.entries(source)) {
    const nk = attachmentKeyNorm(k);
    const childHint = hint
      || ATTACHMENT_CONTAINER_KEYS.has(nk)
      || nk.includes('attachment')
      || nk.includes('piecejointe')
      || nk === 'file'
      || nk === 'files'
      || nk === 'document'
      || nk === 'documents'
      || nk.endsWith('file')
      || nk.endsWith('filename')
      || nk.endsWith('document');
    if (childHint || (v && typeof v === 'object')) {
      collectAttachmentCandidates(v, out, seen, childHint);
    }
  }
  return out;
}

function attachmentSourceUrl(a) {
  if (!a) return '';
  if (typeof a === 'string') return /^https?:\/\//i.test(a) || a.startsWith('/') ? a : '';
  return scalarFirst(
    a.downloadUrl, a.download_url, a.url, a.href, a.uri, a.link,
    a['@_href'], a['@_url'], a['@_download_url'], a['@_downloadUrl'],
    a.file_url, a.fileUrl, a.content_url, a.contentUrl,
    a.document_url, a.documentUrl, a.public_url, a.publicUrl,
    a.download?.url, a.download?.href,
    a.links?.download?.href, a.links?.download?.url,
    a._links?.download?.href, a._links?.download?.url,
    a.self, a.location
  );
}

function attachmentSourceId(a) {
  if (!a || typeof a === 'string') return '';
  return scalarFirst(
    a.id, a['@_id'], a.file_id, a.fileId, a.attachment_id, a.attachmentId,
    a['@_attachment_id'], a['@_attachmentId'],
    a.document_id, a.documentId, a.uuid, a.resource_id, a.resourceId
  );
}

function providerCanDownloadAttachmentById(provider) {
  // Mirakl M13 permet de télécharger une pièce jointe via son attachment_id.
  return provider?.type === 'mirakl';
}

function normalizeAttachmentObject(a, index = 0) {
  const sourceUrl = attachmentSourceUrl(a);
  const rawName = typeof a === 'string' ? '' : scalarFirst(
    a?.name, a?.file_name, a?.filename, a?.fileName, a?.label, a?.title,
    a?.originalname, a?.document_name, a?.documentName, a?.display_name,
    a?.['#text'], a?.['@_name'], a?.['@_filename'], a?.['@_file_name']
  );
  const fromUrl = sourceUrl
    ? decodeURIComponent(String(sourceUrl).split('?')[0].split('/').filter(Boolean).pop() || '')
    : '';
  const cleanName = cleanText(rawName || fromUrl);
  const sizeRaw = typeof a === 'string' ? '' : scalarFirst(a?.size, a?.file_size, a?.fileSize, a?.length, a?.content_length, a?.contentLength, a?.['@_size']);
  const size = Number(sizeRaw) || null;
  const type = typeof a === 'string' ? '' : cleanText(scalarFirst(a?.mimeType, a?.mimetype, a?.mime_type, a?.content_type, a?.contentType, a?.type, a?.['@_mime_type'], a?.['@_content_type']));
  const id = attachmentSourceId(a);
  const name = cleanName || (sourceUrl ? `Pièce jointe ${index + 1}` : '');
  const out = { name, size, type, id, url: sourceUrl };
  Object.keys(out).forEach(k => { if (out[k] === '' || out[k] == null) delete out[k]; });
  return out;
}

function isUsableInboundAttachment(a) {
  if (!a) return false;
  // Une simple valeur "0", "1" ou un objet {id:"0", name:"Client"} n'est pas un fichier.
  // Pour éviter le bug Darty, un nom seul ne suffit pas : il faut une URL, ou un ID + vrai signal de fichier.
  if (a.url) return true;
  if (a.id && (a.size || a.type || looksLikeAttachmentFilename(a.name))) return true;
  if (looksLikeAttachmentFilename(a.name) && (a.size || a.type)) return true;
  return false;
}

function normalizeInboundAttachments(source) {
  const candidates = collectAttachmentCandidates(source);

  const seen = new Set();
  return candidates
    .filter(Boolean)
    .map((a, i) => normalizeAttachmentObject(a, i))
    .filter(isUsableInboundAttachment)
    .filter(a => {
      const key = [a.id, a.url, a.name, a.size].filter(Boolean).join('|').toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function decorateClaimAttachmentsForPublic(provider, claim) {
  const copy = typeof structuredClone === 'function'
    ? structuredClone(claim)
    : JSON.parse(JSON.stringify(claim));
  delete copy._ctx;

  const claimId = copy.id || claim?.id || '';
  if (Array.isArray(copy.messages)) {
    copy.messages = copy.messages.map((m, messageIndex) => {
      const msg = { ...m };
      const rawMsg = Array.isArray(claim?.messages) ? claim.messages[messageIndex] : m;
      const sourceAttachments = Array.isArray(rawMsg?.attachments) ? rawMsg.attachments : normalizeInboundAttachments(rawMsg);
      msg.attachments = normalizeInboundAttachments({ attachments: sourceAttachments }).map((a, attachmentIndex) => {
        const hasDownloadSource = Boolean(a.url || (a.id && providerCanDownloadAttachmentById(provider)));
        const safeName = cleanText(a.name || `Pièce jointe ${attachmentIndex + 1}`);
        const downloadUrl = hasDownloadSource && claimId
          ? `/api/reclamations/threads/${encodeURIComponent(claimId)}/attachments/${messageIndex}/${attachmentIndex}`
          : '';
        return {
          name: safeName,
          ...(a.size ? { size: a.size } : {}),
          ...(a.type ? { type: a.type } : {}),
          ...(downloadUrl ? { downloadUrl, downloadable: true } : { downloadable: false, reason: a.id ? 'Identifiant de pièce jointe sans endpoint connu' : 'URL absente' }),
        };
      });
      return msg;
    });
  }
  return copy;
}

function foldStatusText(v) {
  return cleanText(v)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

function isClosedMarketplaceStatus(raw) {
  const s = foldStatusText(raw);
  if (!s) return false;
  return /(closed|close|cloture|cloturee|resolved|resolu|resolue|termine|terminee|terminated|done|complete|completed|archive|archived|annule|annulee|cancelled|canceled)/.test(s);
}

function normalizeMarketplaceStatus(raw, fallback = 'nouveau') {
  const s = foldStatusText(raw);
  if (!s) return fallback;
  if (isClosedMarketplaceStatus(s)) return 'resolu';
  if (/(waiting|pending|attente|a traiter|a repondre|answer required|seller answer|unread|nouveau|new|opened|open|ongoing|in progress|en cours)/.test(s)) return 'nouveau';
  return fallback;
}

function isClaimClosedByMarketplace(claim) {
  const ctx = claim?._ctx || {};
  return claim?.status === 'resolu'
    || ctx.closedByMarketplace === true
    || isClosedMarketplaceStatus(claim?.marketplaceStatus)
    || isClosedMarketplaceStatus(claim?.statusRaw)
    || isClosedMarketplaceStatus(ctx.marketplaceStatus)
    || isClosedMarketplaceStatus(ctx.rawStatus);
}

function applyMarketplaceStatus(claim, rawStatus) {
  if (!claim) return claim;
  const raw = scalarFirst(rawStatus, claim.marketplaceStatus, claim.statusRaw, claim._ctx?.marketplaceStatus, claim._ctx?.rawStatus);
  if (raw) {
    claim.marketplaceStatus = raw;
    claim.statusRaw = raw;
    claim.status = normalizeMarketplaceStatus(raw, claim.status || 'nouveau');
    claim._ctx = {
      ...(claim._ctx || {}),
      marketplaceStatus: raw,
      rawStatus: raw,
      closedByMarketplace: isClosedMarketplaceStatus(raw),
    };
  }
  return claim;
}
function looksLikeMessageSubjectSnippet(v) {
  const s = cleanText(v);
  if (!s) return false;
  const folded = s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

  // Quand Fnac/Darty ne fournit pas de vrai motif, certains champs contiennent
  // le début du message client. Ce n'est pas un sujet lisible pour le tableau.
  if (/^(bonjour|bonsoir|bjr|hello|madame|monsieur|cher|chere)\b/.test(folded)) return true;
  if (/\b(je vous contacte|je reviens vers vous|suite a|suite a ma commande|j ai commande|j'ai commande|j ai recu|j'ai recu|je n ai|je n'ai|je voudrais|je souhaite|pouvez vous|pourriez vous|merci de|svp|cordialement)\b/.test(folded)) return true;
  if (s.length > 80) return true;
  if (s.split(/\s+/).length > 10 && /[.!?;:]/.test(s)) return true;
  return false;
}

function isBadSubject(v) {
  const s = cleanText(v);
  if (!s) return true;
  // Certains opérateurs renvoient un code numérique ou un libellé générique.
  // Ce code/libellé ne doit jamais être affiché comme sujet client.
  if (/^[#_\-\s]*\d+[#_\-\s]*$/.test(s)) return true;
  if (/^(topic|subject|reason|motif)[_\-\s]*\d+$/i.test(s)) return true;

  const compact = s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  // Fnac/Darty/BOMP renvoie souvent des codes techniques dans <type>, par ex. ORDER.
  // Ces valeurs servent à router la conversation, mais ne sont pas des sujets client.
  if (/^(order|order_information|orderinformation|client_order|client_order_comment|message|message_order|incident|case|claim|request|thread|discussion|client|customer|seller|shop|system|callcenter)$/i.test(compact)) return true;

  // Sécurité v5 : ne jamais afficher une phrase client comme sujet.
  if (looksLikeMessageSubjectSnippet(s)) return true;

  if (/^(r[ée]clamation|r[ée]clamation client|incident|message client|demande client|customer claim|customer complaint|claim|echanger avec le vendeur partenaire|échanger avec le vendeur partenaire)$/i.test(s)) return true;
  return false;
}
function firstReadableSubject(...values) {
  for (const v of values) {
    if (v && typeof v === 'object') {
      const nested = firstReadableSubject(v.label, v.name, v.title, v.value, v.code);
      if (nested) return nested;
      continue;
    }
    const s = cleanText(v);
    if (!isBadSubject(s)) return s;
  }
  return '';
}
function inferSubjectFromText(text) {
  const s = cleanText(text);
  if (!s) return '';
  const t = s.toLowerCase();
  if (/(colis|commande).*(pas|non|jamais|aucun|rien).*(reçu|recu|livré|livre)|livré.*rien reçu|non[ -]?reçu|colis perdu|suivi.*livr/.test(t)) return 'Colis non reçu';
  if (/endommag|cass[ée]e?|fissur|ab[iî]m|ray[eé]|enfonc|bris[eé]/.test(t)) return 'Produit endommagé';
  if (/d[ée]fect|panne|ne fonctionne|fonctionne pas|ne s.allume|hs|hors service|gr[eé]sille/.test(t)) return 'Produit défectueux';
  if (/non conforme|mauvais[e]? r[ée]f[ée]rence|erreur de r[ée]f[ée]rence|pas celui command|autre mod[eè]le|mauvais produit|coloris.*correspond/.test(t)) return 'Produit non conforme';
  if (/manquant|pi[eè]ce manquante|visserie|accessoire manquant|il manque/.test(t)) return 'Pièce manquante';
  if (/annul|annulation/.test(t)) return 'Annulation de commande';
  if (/rendez[ -]?vous|rdv|cr[eé]neau|reprogramm/.test(t)) return 'Livraison / rendez-vous';
  if (/retour|renvoi|renvoyer|retractation|rétractation|[ée]tiquette retour/.test(t)) return 'Demande de retour';
  if (/rembours|avoir|cr[ée]dit/.test(t)) return 'Remboursement';
  if (/facture/.test(t)) return 'Facture manquante';
  if (/garantie|sav|service apr[eè]s vente/.test(t)) return 'Question SAV / garantie';
  if (/retard|d[ée]lai|livraison.*d[ée]pass|livraison.*repouss|toujours rien|pas de nouvelle/.test(t)) return 'Retard de livraison';

  // Avant, on recopiait ici le début du message client. En v5, on ne le fait plus :
  // si aucun motif fiable n'est reconnu, le sujet reste générique et le message complet
  // reste consultable uniquement dans la conversation.
  return '';
}
function normalizeSubject(subject, fallbackText = '') {
  const direct = firstReadableSubject(subject);
  if (direct) return direct;
  const rejectedSubject = cleanText(subject);
  const textForInference = [fallbackText, rejectedSubject].filter(Boolean).join(' ');
  return inferSubjectFromText(textForInference) || 'Réclamation client';
}
async function fetchWithTimeout(url, options = {}, timeoutMs = Number(process.env.PROVIDER_TIMEOUT_MS || 15000)) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

function isMultipartRequest(req) {
  return /^multipart\/form-data\b/i.test(String(req.headers['content-type'] || ''));
}
function contentTypeBoundary(req) {
  const ct = String(req.headers['content-type'] || '');
  const m = ct.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  return (m && (m[1] || m[2])) ? String(m[1] || m[2]).trim() : '';
}
function parseMultipartHeaderParams(value) {
  const out = {};
  String(value || '').split(';').slice(1).forEach(part => {
    const eq = part.indexOf('=');
    if (eq < 0) return;
    const key = part.slice(0, eq).trim().toLowerCase();
    let val = part.slice(eq + 1).trim();
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    out[key] = val.replace(/\\"/g, '"');
  });
  return out;
}
async function readRequestBuffer(req, maxBytes = Number(process.env.MAX_UPLOAD_BYTES || 15 * 1024 * 1024)) {
  return await new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(Object.assign(new Error(`Pièces jointes trop volumineuses : maximum ${Math.round(maxBytes / 1024 / 1024)} Mo par envoi.`), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function parseMultipartFormData(req) {
  const boundary = contentTypeBoundary(req);
  if (!boundary) throw Object.assign(new Error('Requête multipart invalide : boundary manquante'), { statusCode: 400 });

  const raw = await readRequestBuffer(req);
  const boundaryBuffer = Buffer.from(`--${boundary}`);
  const fields = {};
  const files = [];
  let cursor = raw.indexOf(boundaryBuffer);

  while (cursor >= 0) {
    cursor += boundaryBuffer.length;
    // Fin multipart : --boundary--
    if (raw[cursor] === 45 && raw[cursor + 1] === 45) break;
    // Saut CRLF après boundary
    if (raw[cursor] === 13 && raw[cursor + 1] === 10) cursor += 2;

    const next = raw.indexOf(boundaryBuffer, cursor);
    if (next < 0) break;
    let part = raw.slice(cursor, next);
    // Chaque partie se termine généralement par CRLF juste avant la boundary suivante.
    if (part.length >= 2 && part[part.length - 2] === 13 && part[part.length - 1] === 10) {
      part = part.slice(0, -2);
    }

    const sep = part.indexOf(Buffer.from('\r\n\r\n'));
    if (sep >= 0) {
      const headerText = part.slice(0, sep).toString('latin1');
      const content = part.slice(sep + 4);
      const headers = {};
      headerText.split(/\r\n/).forEach(line => {
        const idx = line.indexOf(':');
        if (idx > 0) headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
      });
      const disposition = headers['content-disposition'] || '';
      const params = parseMultipartHeaderParams(disposition);
      const fieldname = params.name || '';
      const filename = params.filename || '';
      if (fieldname) {
        if (filename) {
          files.push({
            fieldname,
            originalname: path.basename(filename),
            mimetype: headers['content-type'] || 'application/octet-stream',
            size: content.length,
            buffer: content,
          });
        } else {
          const value = content.toString('utf8');
          if (fields[fieldname] === undefined) fields[fieldname] = value;
          else if (Array.isArray(fields[fieldname])) fields[fieldname].push(value);
          else fields[fieldname] = [fields[fieldname], value];
        }
      }
    }
    cursor = next;
  }

  return { fields, files };
}
async function readReplyPayload(req) {
  if (isMultipartRequest(req)) {
    const parsed = await parseMultipartFormData(req);
    const body = cleanText(scalarFirst(parsed.fields.body, parsed.fields.message, parsed.fields.text));
    const status = cleanText(scalarFirst(parsed.fields.status));
    const files = (parsed.files || []).filter(f => ['attachments', 'files', 'file'].includes(String(f.fieldname || '').toLowerCase()));
    return { body, status, files };
  }
  return {
    body: cleanText(req.body?.body || req.body?.message || req.body?.text || ''),
    status: cleanText(req.body?.status || ''),
    files: [],
  };
}
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}


function parseBoolFlag(v, defaultValue = false) {
  if (v === undefined || v === null || v === '') return defaultValue;
  return /^(1|true|yes|on)$/i.test(String(v));
}

function positiveInt(v, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

const BOMP_ALLOWED_MESSAGE_FROM_TYPES = new Set(['CLIENT', 'CALLCENTER', 'SELLER', 'SYSTEM']);
function bompMessageFromTypesFromEnv(name, fallback) {
  const raw = String(process.env[name] || fallback || '');
  const values = raw
    .split(',')
    .map(v => v.trim().toUpperCase())
    .filter(Boolean);
  const clean = [];
  const seen = new Set();
  for (const value of values) {
    if (!BOMP_ALLOWED_MESSAGE_FROM_TYPES.has(value)) {
      if (String(process.env.BOMP_DEBUG || '') === '1') {
        console.warn(`[bomp] from_type ignoré pour ${name}: ${value} (autorisé: CLIENT, CALLCENTER, SELLER, SYSTEM)`);
      }
      continue;
    }
    if (!seen.has(value)) {
      clean.push(value);
      seen.add(value);
    }
  }
  return clean;
}

function promiseWithTimeout(promise, timeoutMs, label = 'opération') {
  const ms = Number(timeoutMs || 0);
  if (!ms || ms <= 0) return promise;
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error(`${label} trop longue (${ms} ms)`), { statusCode: 504 })), ms);
    })
  ]).finally(() => clearTimeout(timer));
}

const notesCache = new Map();
const notesInFlight = new Map();
const notesLastRefreshStart = new Map();

function notesRequestOptions(query = {}) {
  const fast = String(query.fast ?? process.env.NOTES_FAST_MODE ?? '1') !== '0';
  return {
    fast,
    providers: cleanText(query.providers || process.env.NOTES_PROVIDERS || ''),
    includeMirakl: parseBoolFlag(query.includeMirakl ?? process.env.MIRAKL_NOTES_FAST_ENABLE, !fast),
    enrich: parseBoolFlag(query.enrich ?? process.env.NOTES_ENRICH, !fast),
    pages: positiveInt(query.pages || query.maxPages, fast ? 1 : 3, 1, 50),
    pageSize: positiveInt(query.pageSize || query.limitPerPage, fast ? 50 : 100, 1, 500),
    maxOrders: positiveInt(query.maxOrders, fast ? 8 : 40, 0, 500),
    limit: positiveInt(query.limit, fast ? 150 : 0, 0, 5000),
    concurrency: positiveInt(query.concurrency || process.env.NOTES_PROVIDER_CONCURRENCY || process.env.PROVIDER_CONCURRENCY, fast ? 2 : 4, 1, 20),
    providerTimeoutMs: positiveInt(query.providerTimeoutMs || process.env.NOTES_PROVIDER_TIMEOUT_MS, fast ? 9000 : 30000, 0, 120000),
    cacheTtlMs: positiveInt(query.cacheTtlMs || process.env.NOTES_CACHE_TTL_MS, 10 * 60 * 1000, 0, 24 * 60 * 60 * 1000),
    staleWhileRefresh: String(query.stale ?? process.env.NOTES_STALE_WHILE_REFRESH ?? '1') !== '0',
    refreshCooldownMs: positiveInt(query.refreshCooldownMs || process.env.NOTES_REFRESH_COOLDOWN_MS, 60000, 0, 24 * 60 * 60 * 1000),
  };
}

function notesCacheKey(opts) {
  return JSON.stringify({
    fast: opts.fast,
    providers: opts.providers,
    includeMirakl: opts.includeMirakl,
    enrich: opts.enrich,
    pages: opts.pages,
    pageSize: opts.pageSize,
    maxOrders: opts.maxOrders,
    limit: opts.limit,
  });
}

function filterNoteProviders(providers, opts) {
  const wanted = new Set(String(opts.providers || '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean));

  return providers.filter(p => {
    const code = String(p.code || 'octopia').toLowerCase();
    const type = String(p.type || '').toLowerCase();
    if (wanted.size && !wanted.has(code) && !wanted.has(type)) return false;

    // Mode rapide : Mirakl est le plus coûteux car OR51 est appelé commande par commande.
    // Il reste activable avec ?includeMirakl=1 ou ?fast=0.
    if (opts.fast && type === 'mirakl' && !opts.includeMirakl) return false;
    return true;
  });
}

async function collectProductNotes(options = {}) {
  const all = [];
  const providers = filterNoteProviders(
    configured().filter(p => typeof ADAPTERS[p.type]?.fetchProductNotes === 'function'),
    options
  );

  await mapLimit(providers, options.concurrency, async (p) => {
    try {
      const fetched = await promiseWithTimeout(
        ADAPTERS[p.type].fetchProductNotes(p, options),
        options.providerTimeoutMs,
        `notes ${p.type}/${p.code || 'octopia'}`
      );
      const clean = dedupeProductNotes(fetched).map(n => {
        const copy = { ...n };
        delete copy._ctx;
        return copy;
      });
      all.push(...clean);
      console.log(`[${p.type}/${p.code || 'octopia'}] ${clean.length} note(s) produit/client récupérée(s)`);
    } catch (e) {
      console.error(`[notes/${p.type}/${p.code || ''}] ${e.message}`);
    }
  });

  all.sort((a, b) => Number(b.at || 0) - Number(a.at || 0));
  return options.limit ? all.slice(0, options.limit) : all;
}

async function getProductNotesCached(options = {}, forceRefresh = false) {
  const key = notesCacheKey(options);
  const now = Date.now();
  const cached = notesCache.get(key);

  if (!forceRefresh && cached && options.cacheTtlMs > 0 && (now - cached.at) < options.cacheTtlMs) {
    return { data: cached.data, cache: 'HIT', key };
  }

  if (forceRefresh && cached && options.refreshCooldownMs > 0) {
    const last = notesLastRefreshStart.get(key) || cached.at || 0;
    if (now - last < options.refreshCooldownMs) {
      return { data: cached.data, cache: 'COOLDOWN', key };
    }
  }

  if (notesInFlight.has(key)) {
    if (cached && options.staleWhileRefresh) {
      return { data: cached.data, cache: 'WAIT-STALE', key };
    }
    const data = await notesInFlight.get(key);
    return { data: data || notesCache.get(key)?.data || [], cache: 'WAIT', key };
  }

  if (!forceRefresh && cached && options.staleWhileRefresh) {
    notesLastRefreshStart.set(key, now);
    const refresh = collectProductNotes(options)
      .then(data => {
        notesCache.set(key, { at: Date.now(), data });
        return data;
      })
      .catch(e => {
        console.error('[notes/cache refresh]', e.message);
        return cached.data;
      })
      .finally(() => notesInFlight.delete(key));
    notesInFlight.set(key, refresh);
    return { data: cached.data, cache: 'STALE', key };
  }

  notesLastRefreshStart.set(key, now);
  const task = collectProductNotes(options)
    .then(data => {
      notesCache.set(key, { at: Date.now(), data });
      return data;
    })
    .finally(() => notesInFlight.delete(key));
  notesInFlight.set(key, task);
  const data = await task;
  return { data, cache: 'MISS', key };
}

/* =====================================================================
   3) ADAPTATEUR OCTOPIA  (Cdiscount, Rakuten, Alltricks, …)
   API Discussions v2 — endpoints réels.
   =====================================================================*/
const octopia = (() => {
  let tokenCache = { value: null, exp: 0 };

  async function getToken(auth) {
    if (tokenCache.value && Date.now() < tokenCache.exp) return tokenCache.value;
    const body = new URLSearchParams({
      client_id: auth.clientId, client_secret: auth.clientSecret, grant_type: 'client_credentials',
    });
    const res = await fetchWithTimeout(auth.tokenUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw Object.assign(new Error(`Octopia auth ${res.status}${txt ? ' — ' + txt.slice(0, 500) : ''}`), { statusCode: res.status, provider: 'octopia', operation: 'auth' });
    }
    const j = await res.json();
    tokenCache = { value: j.access_token, exp: Date.now() + Math.max(60, (Number(j.expires_in || 7200) - 300)) * 1000 }; // -5 min de marge
    return tokenCache.value;
  }

  async function api(provider, path, opts = {}) {
    const auth = provider.auth;
    const token = await getToken(auth);
    const url = `${auth.apiBase}${path}`;
    const res = await fetchWithTimeout(url, {
      ...opts,
      headers: {
        Authorization: `Bearer ${token}`,
        SellerId: auth.sellerId,
        Accept: 'application/json',
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
        ...opts.headers,
      },
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw Object.assign(new Error(`Octopia ${res.status} (${path})${txt ? ' — ' + txt.slice(0, 1000) : ''}`), { statusCode: res.status, provider: 'octopia', operation: path });
    }
    return res.status === 204 ? {} : res.json();
  }

  function graduationToPriority(g) {
    return (g === 'Claim' || g === 'Level_1' || /claim/i.test(String(g || ''))) ? 'haute' : 'moyenne';
  }

  function extractList(payload) {
    if (Array.isArray(payload)) return payload;
    return payload?.items || payload?.data || payload?.discussions || payload?.results || payload?.content || [];
  }

  function extractMessages(d) {
    const raw = d?.messages || d?.messageList || d?.discussionMessages || d?.lastMessages || d?.conversation?.messages || [];
    const arr = Array.isArray(raw) ? raw : (raw ? [raw] : []);
    const last = d?.message || d?.lastMessage || d?.last_message;
    const all = last ? [...arr, last] : arr;
    const seen = new Set();
    return all.map(m => {
      const senderType = scalarFirst(m.sender?.userType, m.sender?.type, m.senderType, m.userType, m.author?.type);
      const text = cleanText(m.body || m.content || m.text || m.message || m.description || '');
      const at = parseMarketplaceDate(m.createdAt || m.creationDate || m.updatedAt || m.date || m.sentAt, Date.now());
      const attachments = normalizeInboundAttachments(m);
      const attKey = attachments.map(a => a.id || a.url || a.name).join(',');
      const key = `${senderType}|${at}|${text}|${attKey}`;
      if ((!text && !attachments.length) || seen.has(key)) return null;
      seen.add(key);
      return {
        from: /customer|buyer|client/i.test(senderType) ? 'client' : 'seller',
        author: scalarFirst(m.sender?.displayName, m.sender?.name, m.author?.name) || (/customer|buyer|client/i.test(senderType) ? 'Client' : 'Agent'),
        at,
        text,
        attachments,
      };
    }).filter(Boolean).sort((a, b) => a.at - b.at);
  }

  function mapDiscussion(provider, d) {
    d = d?.data || d?.item || d?.discussion || d;
    const discussionId = scalarFirst(d.discussionId, d.id, d.discussion?.id, d.href);
    const salesChannel = scalarFirst(d.salesChannel, d.channel, d.sales_channel, d.salesChannelCode, d.marketplace);
    const customerId = scalarFirst(d.customerId, d.customer?.id, d.buyer?.id, d.clientId, d.customer?.customerId, d.sender?.userId);
    const messages = extractMessages(d);
    const marketplace = provider.channelMap[salesChannel] || (salesChannel || 'octopia').toLowerCase();
    const lastClientText = [...messages].reverse().find(m => m.from === 'client')?.text || '';
    const rawStatus = scalarFirst(d.status, d.state, d.statusLabel, d.stateLabel, d.isOpen === false ? 'CLOSED' : 'OPEN');
    const isOpen = d.isOpen !== false && !isClosedMarketplaceStatus(rawStatus);
    return makeClaim(marketplace, {
      providerType: 'octopia',
      id: discussionId,
      customer: scalarFirst(d.customer?.name, d.customerName, d.buyer?.name, customerId) || 'Client',
      subject: normalizeSubject(firstReadableSubject(d.subject, d.title, d.topic, d.reason, d.reasonLabel), lastClientText),
      orderId: scalarFirst(d.orderSellerId, d.orderReference, d.orderId, d.order?.id, d.order?.orderId),
      product: scalarFirst(d.productId, d.product?.id, d.product?.title, d.offerSellerId, d.sku),
      priority: graduationToPriority(d.graduation || d.level || d.type),
      status: isOpen ? normalizeMarketplaceStatus(rawStatus, 'nouveau') : 'resolu',
      marketplaceStatus: rawStatus,
      updatedAt: parseMarketplaceDate(d.updatedAt || d.lastUpdateDate || d.lastMessageDate || d.createdAt, Date.now()),
      messages,
      tracking: normalizeTracking(d.tracking || d.shipment || d.shipping || d.delivery, d),
      ctx: { discussionId, salesChannel, customerId, kind: 'discussion', marketplaceStatus: rawStatus, rawStatus, closedByMarketplace: !isOpen },
    });
  }

  return {
    async fetchClaims(provider) {
      // includeMessages=LastMessage est important : sans cela l'API peut renvoyer des discussions
      // sans message, et le filtre "à répondre" les supprimait ensuite.
      const pageSize = Number(process.env.OCTOPIA_PAGE_SIZE || 50);
      const maxPages = Number(process.env.OCTOPIA_MAX_PAGES || 3);
      const all = [];
      for (let pageIndex = 1; pageIndex <= maxPages; pageIndex++) {
        const qs = new URLSearchParams({
          isOpen: 'true',
          includeMessages: 'LastMessage',
          pageIndex: String(pageIndex),
          pageSize: String(pageSize),
        });
        const data = await api(provider, `/discussions?${qs.toString()}`);
        const items = extractList(data);
        all.push(...items.map(d => mapDiscussion(provider, d)).filter(c => c._ctx.discussionId));
        if (!items.length || items.length < pageSize) break;
      }
      return all;
    },

    // Récupère et normalise le fil complet d'une discussion.
    async fetchThread(provider, ctxOrId) {
      const discussionId = scalarFirst(ctxOrId?.discussionId, ctxOrId?.id, ctxOrId);
      if (!discussionId) throw Object.assign(new Error('Octopia : discussionId manquant pour le détail'), { statusCode: 400, provider: 'octopia', operation: 'fetchThread' });
      const raw = await api(provider, `/discussions/${encodeURIComponent(discussionId)}`);
      return mapDiscussion(provider, raw);
    },

    async fetchProductNotes(provider, options = {}) {
      // Octopia ne fournit pas ici les avis textuels unitaires. En revanche,
      // GET /offers?salesChannelId=...&expand=salesChannelFeedback renvoie les métriques
      // productReviewsAverageRating / productReviewsCount par produit.
      const notes = [];
      const pageSize = positiveInt(options.pageSize || process.env.OCTOPIA_NOTES_PAGE_SIZE, options.fast ? 50 : 100, 1, 500);
      const maxPages = positiveInt(options.pages || process.env.OCTOPIA_NOTES_MAX_PAGES, 1, 1, 10);
      const channels = Object.keys(provider.channelMap || {}).length ? Object.keys(provider.channelMap || {}) : ['CDISFR'];

      for (const salesChannelId of channels) {
        const marketplace = provider.channelMap?.[salesChannelId] || String(salesChannelId || 'octopia').toLowerCase();
        for (let page = 1; page <= maxPages; page++) {
          const qs = new URLSearchParams({
            salesChannelId,
            limit: String(pageSize),
            expand: 'salesChannelFeedback',
          });
          const data = await api(provider, `/offers?${qs.toString()}`);
          const offers = extractList(data);
          for (const offer of offers) {
            const fbRaw = offer.salesChannelFeedback || offer.sales_channel_feedback || offer.feedback || {};
            const feedbacks = Array.isArray(fbRaw) ? fbRaw : [fbRaw];
            for (const fb of feedbacks) {
              const pi = fb?.productInformation || fb?.product_information || offer.productInformation || offer.product_information || {};
              const rating = normalizeRatingValue(pi.productReviewsAverageRating ?? pi.product_reviews_average_rating);
              const count = Number(pi.productReviewsCount ?? pi.product_reviews_count ?? 0);
              if (!rating && !count) continue;
              const product = scalarFirst(offer.product?.title, offer.productTitle, offer.product_title, offer.title, offer.offerId, offer.sellerExternalReference);
              const ean = scalarFirst(offer.gtin, offer.product?.gtin, offer.productReference, offer.product_reference, offer.sellerExternalReference);
              notes.push(makeProductNote(marketplace, {
                providerType: 'octopia',
                id: scalarFirst(offer.offerId, offer.id, offer.sellerExternalReference, ean),
                product,
                ean,
                rating,
                visible: true,
                comment: count ? `${count} avis produit — moyenne ${rating}/5 (donnée agrégée Octopia)` : `Moyenne produit ${rating}/5 (donnée agrégée Octopia)`,
                at: scalarFirst(pi.updatedAt, pi.updated_at, fb.updatedAt, offer.updatedAt),
                source: 'octopia_offer_feedback',
                ctx: { salesChannelId, aggregate: true, reviewsCount: count }
              }));
            }
          }
          if (!offers.length || offers.length < pageSize) break;
        }
      }
      return dedupeProductNotes(notes);
    },

    async sendReply(provider, ctx, body) {
      // POST /messages — body 13–5000 caractères, destinataire = le client
      const message = cleanText(body);
      const discussionId = scalarFirst(ctx?.discussionId, ctx?.id);
      const salesChannel = scalarFirst(ctx?.salesChannel, ctx?.channel);
      const customerId = scalarFirst(ctx?.customerId, ctx?.customer?.id);
      if (!discussionId) throw Object.assign(new Error('Octopia : discussionId manquant ou invalide'), { statusCode: 400, provider: 'octopia', operation: 'sendReply' });
      if (!salesChannel) throw Object.assign(new Error('Octopia : salesChannel manquant'), { statusCode: 400, provider: 'octopia', operation: 'sendReply' });
      if (!customerId) throw Object.assign(new Error('Octopia : customerId manquant'), { statusCode: 400, provider: 'octopia', operation: 'sendReply' });
      if (message.length < 13) throw Object.assign(new Error('Octopia refuse les messages trop courts : minimum 13 caractères.'), { statusCode: 400, provider: 'octopia', operation: 'sendReply' });
      await api(provider, '/messages', {
        method: 'POST',
        body: JSON.stringify({
          body: message,
          discussionId,
          salesChannel,
          receivers: [{ userId: customerId, userType: 'Customer' }],
        }),
      });
      return { mode: 'octopia_messages' };
    },

    async downloadAttachment(provider, sourceUrl) {
      const auth = provider.auth;
      const token = await getToken(auth);
      const url = /^https?:\/\//i.test(String(sourceUrl || ''))
        ? String(sourceUrl)
        : `${auth.apiBase}${String(sourceUrl || '').startsWith('/') ? '' : '/'}${sourceUrl || ''}`;
      const res = await fetchWithTimeout(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          SellerId: auth.sellerId,
          Accept: '*/*',
        },
      }, Number(process.env.ATTACHMENT_DOWNLOAD_TIMEOUT_MS || 30000));
      await throwHttpError(`Octopia pièce jointe`, res, { provider: 'octopia', operation: 'downloadAttachment' });
      return res;
    },

    async close(provider, ctxOrId) {
      const discussionId = scalarFirst(ctxOrId?.discussionId, ctxOrId?.id, ctxOrId);
      if (!discussionId) return;
      await api(provider, `/discussions/${encodeURIComponent(discussionId)}`, {
        method: 'PATCH',
        body: JSON.stringify([{ op: 'replace', path: '/isOpen', value: false }]),
      });
    },
  };
})();

/* =====================================================================
   4) ADAPTATEUR MIRAKL  (Carrefour, Leroy Merlin, Boulanger, Auchan…)
   =====================================================================*/
function miraklApiBase(rawUrl) {
  // Dans ton .env tu as mis des URLs qui finissent déjà par /api/.
  // Le code ajoute ensuite /api/inbox/..., donc sans normalisation ça devient /api/api/... -> 404.
  return String(rawUrl || '').replace(/\/+$/, '').replace(/\/api$/i, '');
}
async function throwHttpError(prefix, res, extra = {}) {
  if (res.ok) return;
  let body = '';
  try { body = await res.text(); } catch (_) { }
  const err = new Error(`${prefix} ${res.status}${body ? ' — ' + body.slice(0, 700) : ''}`);
  err.statusCode = res.status;
  Object.assign(err, extra);
  throw err;
}

function isJsonLikeText(text) {
  const s = cleanText(text);
  return (s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']'));
}

function extractMiraklRecipients(thread) {
  const candidates = [
    thread?.to,
    thread?.recipients,
    thread?.participants,
    thread?.recipient_list,
    thread?.message_to,
  ].flatMap(v => Array.isArray(v) ? v : (v ? [v] : []));

  const out = [];
  const seen = new Set();
  for (const r of candidates) {
    if (!r || typeof r !== 'object') continue;
    const type = scalarFirst(r.type, r.recipient_type, r.user_type, r.role).toUpperCase();
    const id = scalarFirst(r.id, r.user_id, r.shop_id, r.customer_id, r.organization_id);
    if (!type) continue;
    // On évite de renvoyer au shop courant ; on garde surtout CUSTOMER / OPERATOR si fournis par Mirakl.
    if (type === 'SHOP' || type === 'SELLER') continue;
    const item = id ? { id, type } : { type };
    const key = `${item.type}:${item.id || ''}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(item);
    }
  }
  return out;
}

function appendJsonFormField(form, fieldName, value, jsonAsBlob = false) {
  // Mirakl M12 attend un multipart/form-data avec le champ message_input.
  // La plupart des instances acceptent la valeur JSON sous forme de champ texte.
  // Certaines sont plus strictes et veulent un part application/json : on sait donc tenter les deux formes.
  const json = JSON.stringify(value);
  if (jsonAsBlob) {
    form.append(fieldName, new Blob([json], { type: 'application/json' }));
  } else {
    form.append(fieldName, json);
  }
}
function appendMiraklFiles(form, files = []) {
  for (const f of files || []) {
    if (!f || !f.buffer || !f.size) continue;
    const blob = new Blob([f.buffer], { type: f.mimetype || 'application/octet-stream' });
    // Nom officiel du champ Mirakl pour les pièces jointes M12 : files
    form.append('files', blob, f.originalname || 'piece-jointe');
  }
}
const mirakl = {
  async api(provider, path, attempt = 1) {
    const base = miraklApiBase(provider.url);
    const url = `${base}/api${path.startsWith('/') ? path : '/' + path}`;

    const res = await fetchWithTimeout(url, {
      headers: {
        Authorization: provider.key,
        Accept: 'application/json',
      },
    });

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after') || 0);
      const waitMs = retryAfter > 0 ? retryAfter * 1000 : attempt * 5000;

      console.warn(`[mirakl/${provider.code}] 429 Too Many Requests, pause ${waitMs / 1000}s`);

      if (attempt >= 5) {
        const txt = await res.text().catch(() => '');
        throw new Error(`Mirakl ${provider.code} 429 après ${attempt} tentatives — ${txt.slice(0, 500)}`);
      }

      await sleep(waitMs);
      return this.api(provider, path, attempt + 1);
    }

    await throwHttpError(`Mirakl ${provider.code}`, res);
    return await res.json();
  },

  extractThreads(data) {
    return (
      data?.data ||
      data?.threads ||
      data?.items ||
      data?.results ||
      data?.inbox_threads ||
      []
    );
  },

  extractMessages(thread) {
    return (
      thread?.messages ||
      thread?.data?.messages ||
      thread?.thread?.messages ||
      thread?.inbox_messages ||
      thread?.message_list ||
      []
    );
  },

  mapMessage(m, customerName) {
    const rawDate = m.date_created || m.created_at || m.date_updated || m.updated_at || m.date || null;
    const rawFrom = m.from?.type || m.from_type || m.author_type || m.sender?.type || m.sender_type || m.user_type || '';
    const isCustomer = String(rawFrom).toUpperCase().includes('CUSTOMER') || String(rawFrom).toUpperCase().includes('BUYER');

    return {
      from: isCustomer ? 'client' : 'seller',
      author: m.from?.display_name || m.from?.name || m.author?.name || m.sender?.name || (isCustomer ? customerName : 'Agent'),
      at: parseMarketplaceDate(rawDate),
      rawAt: rawDate,
      text: m.body || m.text || m.message || m.content || m.description || '',
      attachments: normalizeInboundAttachments(m),
    };
  },

  mapThread(provider, thread, ctx = {}) {
    const id = scalarFirst(thread.id, thread.thread_id, thread.threadId, thread.uuid, ctx.threadId);
    const customer = sanitizeCustomerName(scalarFirst(
      fullNameFromPieces(thread.customer?.firstname, thread.customer?.lastname),
      fullNameFromPieces(thread.customer?.first_name, thread.customer?.last_name),
      fullNameFromPieces(thread.buyer?.firstname, thread.buyer?.lastname),
      fullNameFromPieces(thread.buyer?.first_name, thread.buyer?.last_name),
      thread.from?.display_name, thread.from?.name, thread.customer?.name, thread.customer?.display_name,
      thread.customer_name, thread.buyer?.name, thread.buyer_name, ctx.customer
    )) || 'Client';
    const rawCreatedAt = thread.date_created || thread.created_at || thread.creation_date || thread.createdDate || null;
    const rawUpdatedAt = thread.date_updated || thread.updated_at || thread.last_message_date || thread.date_created || thread.created_at || null;
    const messages = this.extractMessages(thread).map(m => this.mapMessage(m, customer));
    const lastMsgAt = messages.map(m => Number(m.at || 0)).filter(Boolean).sort((a, b) => b - a)[0] || parseMarketplaceDate(rawUpdatedAt, Date.now());
    const productEntity = Array.isArray(thread.entities) ? thread.entities.find(e => /product|offer/i.test(e.type || e.entity_type || '')) : null;
    const orderEntity = Array.isArray(thread.entities) ? thread.entities.find(e => /order/i.test(e.type || e.entity_type || '')) : null;
    const eanFromThread = firstOrderEan(
      productEntity, thread.product, thread.offer, thread.entities,
      productEntity?.ean, productEntity?.gtin, productEntity?.barcode, productEntity?.product_ean, productEntity?.product_sku,
      thread.ean, thread.gtin, thread.product?.ean, thread.product?.gtin, thread.offer?.ean, thread.offer?.gtin,
      firstDeepValue(thread, /^(ean|gtin|barcode|product_?ean|product_?gtin)$/i)
    );
    const lastClientText = [...messages].reverse().find(m => m.from === 'client')?.text || '';
    const rawStatus = scalarFirst(thread.status, thread.state, thread.thread_status, thread.closed === true ? 'CLOSED' : 'OPEN');

    const subject = firstReadableSubject(
      thread.topic?.label,
      thread.reason?.label,
      thread.reason_label,
      thread.category?.label,
      thread.subject,
      thread.title,
      thread.topic?.name,
      thread.topic?.value,
      thread.reason?.value
    ) || inferSubjectFromText(lastClientText);

    return makeClaim(provider.code, {
      providerType: 'mirakl',
      id,
      customer,
      subject: normalizeSubject(subject, lastClientText),
      orderId: scalarFirst(orderEntity?.id, orderEntity?.order_id, thread.order_id, thread.orderId, thread.order?.id, thread.entities?.[0]?.id),
      product: scalarFirst(productEntity?.label, productEntity?.name, thread.product_title, thread.product, thread.offer?.sku, thread.entities?.[0]?.label),
      ean: eanFromThread,
      status: normalizeMarketplaceStatus(rawStatus, 'nouveau'),
      marketplaceStatus: rawStatus,
      createdAt: parseMarketplaceDate(rawCreatedAt, messages.length ? Math.min(...messages.map(m => m.at || Date.now())) : Date.now()),
      updatedAt: parseMarketplaceDate(rawUpdatedAt, lastMsgAt),
      lastMessageAt: lastMsgAt,
      messages,
      tracking: normalizeTracking(thread.tracking || thread.shipment || thread.shipping || thread.delivery, thread),
      ctx: {
        threadId: id,
        rawCreatedAt,
        rawUpdatedAt,
        lastMessageAt: lastMsgAt,
        marketplaceStatus: rawStatus,
        rawStatus,
        closedByMarketplace: isClosedMarketplaceStatus(rawStatus),
        miraklRecipients: extractMiraklRecipients(thread),
        customerId: scalarFirst(thread.customer?.id, thread.customer_id, thread.buyer?.id, thread.from?.id),
      },
    });
  },

  async fetchAllThreads(provider) {
    const all = [];

    const max = Number(process.env.MIRAKL_PAGE_SIZE || 10);
    const maxPages = Number(process.env.MIRAKL_MAX_PAGES || 1);
    // Important : pour savoir si une réclamation est vraiment sans réponse,
    // il faut récupérer les messages. Par défaut on les demande à Mirakl.
    const withMessages = String(process.env.MIRAKL_WITH_MESSAGES || 'true') === 'true';
    const monthsBack = Number(process.env.MIRAKL_MONTHS_BACK || 0);

    let offset = 0;
    let pageCount = 0;

    while (pageCount < maxPages) {
      const params = new URLSearchParams();

      params.set('max', String(max));
      params.set('offset', String(offset));

      if (withMessages) params.set('with_messages', 'true');
      if (monthsBack > 0) {
        const since = new Date();
        since.setMonth(since.getMonth() - monthsBack);
        params.set('date_created_from', since.toISOString());
      }

      const data = await this.api(provider, `/inbox/threads?${params.toString()}`);
      const page = this.extractThreads(data);

      console.log(`[mirakl/${provider.code}] page=${pageCount + 1}, offset=${offset}, reçus=${page.length}`);

      all.push(...page);

      if (page.length < max) break;

      offset += max;
      pageCount += 1;

      const delay = Number(process.env.MIRAKL_DELAY_MS || 0);
      if (delay > 0) await sleep(delay);
    }

    console.log(`[mirakl/${provider.code}] total threads chargés=${all.length}`);
    return all;
  },

  extractOrders(data) {
    return data?.orders || data?.data || data?.items || data?.results || [];
  },

  mapOrderForNote(order) {
    return this.mapOrderForClaim(order);
  },

  mapOrderForClaim(order = {}) {
    const orderId = scalarFirst(order.order_id, order.id, order.commercial_id, order.orderId);
    const c = order.customer || {};
    const b = order.buyer || {};
    const ship = order.shipping_address || order.shippingAddress || order.customer_shipping_address || order.customerShippingAddress || {};
    const bill = order.billing_address || order.billingAddress || {};
    const customer = sanitizeCustomerName(scalarFirst(
      fullNameFromPieces(c.firstname, c.lastname),
      fullNameFromPieces(c.first_name, c.last_name),
      fullNameFromPieces(c.firstName, c.lastName),
      c.full_name, c.fullName, c.name, c.display_name,
      fullNameFromPieces(b.firstname, b.lastname),
      fullNameFromPieces(b.first_name, b.last_name),
      b.full_name, b.fullName, b.name,
      fullNameFromPieces(ship.firstname, ship.lastname),
      fullNameFromPieces(ship.first_name, ship.last_name),
      ship.full_name, ship.fullName, ship.name,
      fullNameFromPieces(bill.firstname, bill.lastname),
      fullNameFromPieces(bill.first_name, bill.last_name),
      bill.full_name, bill.fullName, bill.name,
      order.customer_name, order.customerName, order.buyer_name, order.buyerName
    ));
    const lines = order.order_lines || order.lines || order.orderLines || [];
    const firstLine = Array.isArray(lines) ? (lines[0] || {}) : lines;
    const product = scalarFirst(
      firstLine.product_title, firstLine.productTitle, firstLine.product?.title, firstLine.product?.name,
      firstLine.offer_sku, firstLine.offer_id, firstLine.product?.sku, order.product_title
    );
    const lineArray = Array.isArray(lines) ? lines : (lines ? [lines] : []);
    const ean = firstOrderEan(
      ...lineArray,
      firstLine.ean, firstLine.gtin, firstLine.barcode, firstLine.product_ean, firstLine.product_gtin,
      firstLine.product?.ean, firstLine.product?.gtin, firstLine.product?.barcode,
      firstLine.product_sku, firstLine.product?.sku, firstLine.product_id, firstLine.product_reference,
      firstDeepValue(firstLine, /^(ean|gtin|barcode|product_?ean|product_?gtin|product_?sku|product_?reference)$/i),
      firstDeepValue(order, /^(ean|gtin|barcode|product_?ean|product_?gtin|product_?reference)$/i)
    );
    const createdAt = parseMarketplaceDate(scalarFirst(order.date_created, order.created_at, order.order_date, order.createdDate, order.created), 0);
    return { orderId, customer, product, ean, orderCreatedAt: createdAt || null };
  },

  mapEvaluationToNote(provider, order, evaluationPayload) {
    const ev = evaluationPayload?.evaluation || evaluationPayload?.data || evaluationPayload || {};
    const orderInfo = this.mapOrderForNote(order || {});
    const rating = normalizeRatingValue(
      ev.grade || ev.rate || ev.rating || ev.score || ev.mark || ev.note || ev.evaluation_grade || ev.order_evaluation_grade
    );
    const comment = scalarFirst(
      ev.comment, ev.assessment, ev.review, ev.message, ev.description, ev.evaluation_comment,
      ev.customer_comment, ev.reason
    );
    return makeProductNote(provider.code, {
      providerType: 'mirakl',
      id: scalarFirst(ev.id, ev.evaluation_id, orderInfo.orderId),
      orderId: orderInfo.orderId,
      customer: scalarFirst(orderInfo.customer, ev.customer?.name, ev.customer_name),
      product: orderInfo.product,
      ean: orderInfo.ean,
      rating,
      comment,
      visible: ev.visible !== false,
      at: scalarFirst(ev.date_created, ev.created_at, ev.updated_at, ev.date, order.date_created),
      reply: scalarFirst(ev.reply, ev.seller_reply, ev.answer),
      source: 'mirakl_or51',
      ctx: { orderId: orderInfo.orderId }
    });
  },

  async fetchProductNotes(provider, options = {}) {
    // Mirakl expose l'évaluation d'une commande via OR51 : GET /api/orders/{order_id}/evaluation.
    // Comme OR51 est par commande, on récupère d'abord un échantillon de commandes récentes.
    const notes = [];
    const fast = options.fast !== false;
    const maxOrders = positiveInt(options.maxOrders || process.env.MIRAKL_NOTES_MAX_ORDERS, fast ? 8 : 40, 0, 500);
    if (maxOrders <= 0) return [];
    const pageSize = Math.min(positiveInt(options.pageSize || process.env.MIRAKL_NOTES_PAGE_SIZE, fast ? 8 : 20, 1, 100), maxOrders);
    const evalConcurrency = positiveInt(options.evalConcurrency || process.env.MIRAKL_NOTES_CONCURRENCY, fast ? 2 : 3, 1, 10);
    const params = new URLSearchParams({ max: String(pageSize), offset: '0' });
    const monthsBack = Number(process.env.MIRAKL_NOTES_MONTHS_BACK || process.env.MIRAKL_MONTHS_BACK || 0);
    if (monthsBack > 0) {
      const since = new Date();
      since.setMonth(since.getMonth() - monthsBack);
      params.set('start_date', since.toISOString());
    }

    const ordersPayload = await this.api(provider, `/orders?${params.toString()}`);
    const orders = this.extractOrders(ordersPayload).slice(0, maxOrders);

    await mapLimit(orders, evalConcurrency, async (order) => {
      const orderId = scalarFirst(order.order_id, order.id, order.commercial_id, order.orderId);
      if (!orderId) return;
      try {
        const evaluation = await this.api(provider, `/orders/${encodeURIComponent(orderId)}/evaluation`);
        const note = this.mapEvaluationToNote(provider, order, evaluation);
        if (productNoteIsUsable(note)) notes.push(note);
      } catch (e) {
        // Beaucoup de commandes n'ont tout simplement pas d'évaluation : on ignore 404/204/empty.
        if (String(process.env.MIRAKL_DEBUG || '') === '1') {
          console.warn(`[mirakl/${provider.code}] note OR51 ignorée pour ${orderId}: ${e.message}`);
        }
      }
    });

    return dedupeProductNotes(notes);
  },

  async fetchOrdersByIds(provider, orderIds) {
    const ids = [...new Set((orderIds || []).map(String).map(s => s.trim()).filter(Boolean))]
      .slice(0, positiveInt(process.env.MIRAKL_TRACKING_MAX_ORDERS, 120, 1, 500));
    const out = [];
    const chunkSize = positiveInt(process.env.MIRAKL_ORDER_TRACKING_BATCH, 20, 1, 50);

    for (let i = 0; i < ids.length; i += chunkSize) {
      const chunk = ids.slice(i, i + chunkSize);
      const qs = new URLSearchParams();
      qs.set('order_ids', chunk.join(','));
      try {
        const data = await this.api(provider, `/orders?${qs.toString()}`);
        out.push(...this.extractOrders(data));
        continue;
      } catch (e) {
        console.warn(`[mirakl/${provider.code}] suivi commandes: batch /orders?order_ids impossible (${e.message})`);
      }

      // Repli : certaines instances acceptent le détail unitaire.
      for (const id of chunk) {
        try {
          const data = await this.api(provider, `/orders/${encodeURIComponent(id)}`);
          const order = data?.order || data?.data || data;
          if (order && typeof order === 'object') out.push(order);
        } catch (e) {
          console.warn(`[mirakl/${provider.code}] suivi commande ${id} ignoré: ${e.message}`);
        }
      }
    }
    return out;
  },

  async enrichClaimsWithOrderTracking(provider, claims) {
    // Cette étape enrichit aussi les réclamations Mirakl avec les informations commande
    // (nom/prénom client, EAN, produit), pas seulement le suivi transporteur.
    if (String(process.env.MIRAKL_FETCH_ORDER_TRACKING || 'true') === 'false') return claims;
    const targets = (claims || []).filter(c => c?.orderId && (
      !sanitizeCustomerName(c.customer) || c.customer === 'Client' || !c.ean || !c.product ||
      !c.tracking || !c.tracking.carrier || c.tracking.carrier === 'transporteur'
    ));
    if (!targets.length) return claims;

    try {
      const orders = await this.fetchOrdersByIds(provider, targets.map(c => c.orderId));
      const byId = new Map();
      for (const order of orders || []) {
        const ids = [
          order.order_id, order.id, order.orderId, order.commercial_id, order.commercialId,
          order.order_reference, order.orderReference, order.marketplace_order_id, order.marketplaceOrderId
        ].map(v => scalarValue(v)).filter(Boolean);
        for (const id of ids) byId.set(id, order);
      }
      for (const claim of targets) {
        const order = byId.get(String(claim.orderId));
        if (!order) continue;
        const info = this.mapOrderForClaim(order);
        if (info.customer && (!sanitizeCustomerName(claim.customer) || claim.customer === 'Client')) {
          claim.customer = info.customer;
          claim._ctx = { ...(claim._ctx || {}), customer: info.customer };
        }
        if (info.product && !claim.product) claim.product = info.product;
        if (info.ean && !claim.ean) { claim.ean = info.ean; claim._ctx = { ...(claim._ctx || {}), ean: info.ean }; }
        if (info.orderCreatedAt) claim.orderCreatedAt = info.orderCreatedAt;
        const t = normalizeOrderTracking(order);
        if (t) claim.tracking = mergeTrackingInfo(claim.tracking, t);
      }
    } catch (e) {
      console.warn(`[mirakl/${provider.code}] enrichissement suivi ignoré: ${e.message}`);
    }
    return claims;
  },

  async fetchClaims(provider) {
    const threads = await this.fetchAllThreads(provider);
    const claims = threads.map(t => this.mapThread(provider, t));
    return await this.enrichClaimsWithOrderTracking(provider, claims);
  },

  async fetchThread(provider, ctx) {
    const threadId = scalarFirst(ctx?.threadId, ctx?.id);
    if (!threadId) throw Object.assign(new Error('Mirakl : threadId manquant ou invalide'), { statusCode: 400, provider: provider.code, operation: 'fetchThread' });

    // Certaines instances renvoient directement le fil, d'autres un wrapper {data:{...}} ou {thread:{...}}.
    // On demande les messages uniquement au clic, pour garder le chargement initial rapide.
    const data = await this.api(provider, `/inbox/threads/${encodeURIComponent(threadId)}?with_messages=true`);
    const thread = data?.data || data?.thread || data;
    const claim = this.mapThread(provider, thread, { ...ctx, threadId });
    await this.enrichClaimsWithOrderTracking(provider, [claim]);
    return claim;
  },

  async downloadAttachment(provider, sourceUrl, attachment = {}) {
    const base = miraklApiBase(provider.url);
    const raw = String(sourceUrl || '').trim();
    const attId = attachmentSourceId(attachment) || (!/^https?:\/\//i.test(raw) && !raw.startsWith('/') && !raw.includes('/') ? raw : '');

    let url = '';
    let method = 'GET';

    if (raw && (/^https?:\/\//i.test(raw) || raw.startsWith('/') || raw.includes('/'))) {
      url = /^https?:\/\//i.test(raw)
        ? raw
        : raw.startsWith('/api/')
          ? `${base}${raw}`
          : `${base}/api/${raw.replace(/^\/+/, '')}`;
    } else if (attId) {
      // Mirakl M13 : GET /api/inbox/threads/{attachment_id}/download
      url = `${base}/api/inbox/threads/${encodeURIComponent(attId)}/download`;
    }

    if (!url) {
      throw Object.assign(new Error('Mirakl : URL/ID de pièce jointe absent'), {
        statusCode: 404, provider: provider.code, operation: 'downloadAttachment'
      });
    }

    const shopId = scalarFirst(provider.shopId, process.env[`${String(provider.code || '').toUpperCase()}_SHOP_ID`], process.env.MIRAKL_SHOP_ID);
    if (shopId && !/[?&]shop_id=/.test(url)) {
      url += (url.includes('?') ? '&' : '?') + 'shop_id=' + encodeURIComponent(shopId);
    }

    if (String(process.env.ATTACHMENT_DEBUG || '') === '1') {
      console.log(`[attachment/mirakl/${provider.code}] ${method} ${url}`);
      console.log(`[attachment/mirakl/${provider.code}] source=`, JSON.stringify({ raw, attId, attachment }).slice(0, 1500));
    }

    const res = await fetchWithTimeout(url, {
      method,
      headers: {
        Authorization: provider.key,
        Accept: '*/*',
      },
    }, Number(process.env.ATTACHMENT_DOWNLOAD_TIMEOUT_MS || 30000));
    await throwHttpError(`Mirakl ${provider.code} pièce jointe`, res, { provider: provider.code, operation: 'downloadAttachment' });
    return res;
  },

  async sendReply(provider, ctx, body, files = []) {
    const base = miraklApiBase(provider.url);
    const threadId = scalarFirst(ctx?.threadId, ctx?.id);
    const message = String(body || '').trim();
    if (!threadId) throw Object.assign(new Error('Mirakl : threadId manquant ou invalide'), { statusCode: 400, provider: provider.code, operation: 'sendReply' });
    if (!message) throw Object.assign(new Error('Message vide'), { statusCode: 400, provider: provider.code, operation: 'sendReply' });

    const url = `${base}/api/inbox/threads/${encodeURIComponent(threadId)}/message`;

    // Mirakl M12 n'accepte pas un JSON simple {body: ...}.
    // La doc/Postman indiquent un multipart/form-data avec le champ message_input.
    // Selon les opérateurs Mirakl, le destinataire peut être déduit du fil ou exigé.
    // On tente donc d'abord la forme la plus explicite, puis deux secours sûrs.
    const recipients = Array.isArray(ctx?.miraklRecipients) && ctx.miraklRecipients.length
      ? ctx.miraklRecipients
      : [{ type: 'CUSTOMER' }];

    const baseAttempts = [
      { field: 'message_input', input: { body: message, to: recipients } },
      { field: 'message_input', input: { body: message, to_customer: true } },
      { field: 'message_input', input: { body: message } },
    ];
    const attempts = baseAttempts.flatMap(a => [
      { ...a, jsonAsBlob: false },
      { ...a, jsonAsBlob: true },
    ]);

    let lastError = null;
    for (const attempt of attempts) {
      const form = new FormData();
      appendJsonFormField(form, attempt.field, attempt.input, attempt.jsonAsBlob);
      appendMiraklFiles(form, files);

      const res = await fetchWithTimeout(url, {
        method: 'POST',
        headers: {
          Authorization: provider.key,
          Accept: 'application/json',
          // Ne pas mettre Content-Type ici : FormData doit ajouter la boundary.
        },
        body: form,
      });

      if (res.ok) return;

      let txt = '';
      try { txt = await res.text(); } catch (_) { }
      lastError = Object.assign(
        new Error(`Mirakl ${provider.code} ${res.status} — ${txt ? txt.slice(0, 700) : 'échec envoi message_input'}`),
        { statusCode: res.status, provider: provider.code, operation: 'sendReply' }
      );

      // Si c'est une erreur d'authentification ou de droits, les variantes de body ne changeront rien.
      if (res.status === 401 || res.status === 403 || res.status === 404 || res.status === 429) break;

      const lower = String(txt || '').toLowerCase();
      // Pour les erreurs métier qui ne concernent clairement pas le format, inutile de retenter.
      if (lower.includes('closed') || lower.includes('archived') || lower.includes('permission')) break;
    }

    throw lastError || Object.assign(new Error(`Mirakl ${provider.code} : échec envoi message`), { statusCode: 502, provider: provider.code, operation: 'sendReply' });
  },
};

/* =====================================================================
   5) ADAPTATEUR BOMP  (Fnac + Darty)
   API Marketplace Fnac historique, en XML, sur vendeur.fnac.com/api.php.
   Opérations confirmées par la doc Fnac Darty :
     - auth                          (récupère un token de session)
     - incidents_query / _update     (réclamations sur les commandes)
     - messages_query  / _update     (messages clients offres/commandes)
     - client_order_comments_query / _update
   ⚠ Les NOMS EXACTS de balises/attributs XML ci-dessous sont à confirmer
   avec la doc API (accès via la "TeamAPI" Fnac Darty : marketplace.api@fnacdarty.com),
   car ces schémas ne sont pas publics. La mécanique (transport, auth, mapping)
   est en place ; ajustez les chemins de parsing une fois la doc en main.
   =====================================================================*/
const bomp = (() => {
  const FNAC_NS = 'http://www.fnac.com/schemas/mp-dialog.xsd';
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', removeNSPrefix: true });
  const tokens = new Map(); // cache token de session par boutique (code)

  function xmlEscape(v) {
    return String(v ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  function serviceUrl(provider, operation) {
    // Accepte https://vendeur.fnac.com/api.php ou https://vendeur.fnac.com/api.php/
    return `${String(provider.apiBase || '').replace(/\/+$/, '')}/${operation}`;
  }

  function findBompError(parsed, operation) {
    const root = parsed?.[`${operation}_response`] || parsed;
    const err = root?.error || root?.errors?.error || parsed?.error;
    if (!err) return '';
    if (typeof err === 'string') return cleanText(err);
    return cleanText(firstValue(err['#text'], err.message, err.description, err.label, err.code, JSON.stringify(err)));
  }

  function isBompAuthFailureText(txt = '') {
    return /ERR_097|Authentication failed|authentification|authentication/i.test(String(txt || ''));
  }

  function maskBompSecrets(body = '') {
    return String(body || '')
      .replace(/<key>.*?<\/key>/is, '<key>***</key>')
      .replace(/token="[^"]*"/i, 'token="***"')
      .slice(0, 1200);
  }

  async function postXmlOnce(provider, operation, body) {
    const url = serviceUrl(provider, operation);

    if (String(process.env.BOMP_DEBUG || '') === '1') {
      console.log(`[bomp/${provider.code}] POST ${operation} -> ${url}`);
      console.log(maskBompSecrets(body));
    }

    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        Accept: 'text/xml, application/xml, */*',
        'User-Agent': '2KINGS-reclamations-proxy/1.0'
      },
      body,
    });

    const txt = await res.text().catch(() => '');

    if (String(process.env.BOMP_DEBUG || '') === '1') {
      console.log(`[bomp/${provider.code}] ${operation} status=${res.status}`);
      console.log(String(txt || '').slice(0, 2000));
    }

    return { res, txt };
  }

  async function postXml(provider, operation, body, opts = {}) {
    const { res, txt } = await postXmlOnce(provider, operation, body);
    const authFailedHttp = isBompAuthFailureText(txt);

    // Fnac/Darty peut renvoyer ERR_097 lorsqu'un token BOMP gardé en cache est refusé.
    // Dans ce cas on supprime le token, on refait une auth, puis on rejoue UNE fois la requête.
    // Si ça échoue encore, le problème vient réellement des identifiants .env ou des accès API.
    if (!res.ok) {
      if (operation !== 'auth' && authFailedHttp && !opts.retriedAfterAuthRefresh) {
        tokens.delete(provider.code);
        if (String(process.env.BOMP_DEBUG || '') === '1') {
          console.warn(`[bomp/${provider.code}] ${operation}: token refusé (ERR_097), ré-authentification puis retry une fois.`);
        }
        const freshToken = await getToken(provider, { force: true });
        const retriedBody = String(body || '').replace(/token="[^"]*"/i, `token="${xmlEscape(freshToken)}"`);
        return postXml(provider, operation, retriedBody, { retriedAfterAuthRefresh: true });
      }

      throw Object.assign(
        new Error(`BOMP ${operation} HTTP ${res.status}${txt ? ' — ' + txt.slice(0, 1000) : ''}`),
        { statusCode: res.status, provider: provider.code, operation, authFailed: authFailedHttp }
      );
    }

    const parsed = parser.parse(txt || '<empty/>');
    const apiError = findBompError(parsed, operation);
    const authFailedApi = isBompAuthFailureText(apiError || txt);

    if (apiError) {
      if (operation !== 'auth' && authFailedApi && !opts.retriedAfterAuthRefresh) {
        tokens.delete(provider.code);
        if (String(process.env.BOMP_DEBUG || '') === '1') {
          console.warn(`[bomp/${provider.code}] ${operation}: token refusé par API (${apiError}), ré-authentification puis retry une fois.`);
        }
        const freshToken = await getToken(provider, { force: true });
        const retriedBody = String(body || '').replace(/token="[^"]*"/i, `token="${xmlEscape(freshToken)}"`);
        return postXml(provider, operation, retriedBody, { retriedAfterAuthRefresh: true });
      }

      throw Object.assign(
        new Error(`BOMP ${operation} refusé : ${apiError}`),
        { statusCode: 400, provider: provider.code, operation, authFailed: authFailedApi }
      );
    }
    return parsed;
  }

  async function getToken(provider, opts = {}) {
    const cached = tokens.get(provider.code);
    if (!opts.force && String(process.env.BOMP_DISABLE_TOKEN_CACHE || '') !== '1' && cached && Date.now() < cached.exp) return cached.value;
    // Schéma réel Fnac/Darty : les identifiants sont des BALISES, pas des attributs.
    const body = `<?xml version="1.0" encoding="utf-8"?>
<auth xmlns="${FNAC_NS}">
  <partner_id>${xmlEscape(provider.partnerId)}</partner_id>
  <shop_id>${xmlEscape(provider.shopId)}</shop_id>
  <key>${xmlEscape(provider.key)}</key>
</auth>`;
    const r = await postXml(provider, 'auth', body);
    const token = r?.auth_response?.token || r?.auth?.token || r?.token;
    if (!token) throw new Error('BOMP auth : token introuvable (vérifier partner_id / shop_id / key)');
    tokens.set(provider.code, { value: token, exp: Date.now() + 30 * 60 * 1000 });
    return token;
  }

  function authedRequest(provider, token, name, inner = '', attrs = '') {
    return `<?xml version="1.0" encoding="utf-8"?>
<${name} xmlns="${FNAC_NS}" shop_id="${xmlEscape(provider.shopId)}" partner_id="${xmlEscape(provider.partnerId)}" token="${xmlEscape(token)}"${attrs}>
${inner}
</${name}>`;
  }

  function oneOrMany(x) {
    if (!x) return [];
    return Array.isArray(x) ? x : [x];
  }

  function collectNodes(obj, wantedNames, out = []) {
    if (!obj) return out;
    if (Array.isArray(obj)) {
      obj.forEach(v => collectNodes(v, wantedNames, out));
      return out;
    }
    if (typeof obj !== 'object') return out;
    for (const [k, v] of Object.entries(obj)) {
      if (wantedNames.includes(k)) oneOrMany(v).forEach(item => out.push(item));
      collectNodes(v, wantedNames, out);
    }
    return out;
  }

  function extractBompNodes(root, names) {
    const direct = [];
    for (const name of names) {
      direct.push(...oneOrMany(root?.[name]));
      direct.push(...oneOrMany(root?.[`${name}s`]?.[name]));
      direct.push(...oneOrMany(root?.[`${name}_list`]?.[name]));
    }
    const recursive = collectNodes(root, names);
    const seen = new Set();
    return [...direct, ...recursive].filter(x => {
      if (!x || typeof x !== 'object') return false;
      const key = JSON.stringify(x).slice(0, 500);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function truthyBomp(v) {
    const t = normLower(firstValue(v));
    return ['1', 'true', 'yes', 'y', 'oui'].includes(t);
  }

  function firstValue(...values) {
    return scalarFirst(...values);
  }

  function normLower(v) {
    return String(v || '').trim().toLowerCase();
  }

  function parseBompAuthor(v) {
    const t = normLower(v);
    if (/client|customer|buyer|acheteur/.test(t)) return 'client';
    // Sur BOMP Fnac/Darty, CALLCENTER correspond souvent au service client marketplace
    // qui transmet une demande au vendeur. Comme can_answer=true, c'est bien une ligne à traiter.
    if (/call\s*center|callcenter|service\s*client|support|marketplace|op[ée]rateur|operator|fnac|darty/.test(t)) return 'client';
    if (/seller|shop|boutique|merchant|vendeur/.test(t)) return 'seller';
    return t ? (t.includes('client') ? 'client' : 'seller') : 'client';
  }

  function parseBompDate(...values) {
    const raw = firstValue(...values);
    return parseMarketplaceDate(raw, Date.now());
  }

  function bompText(...values) {
    return cleanText(firstValue(...values));
  }

  // Les réponses XML Fnac/Darty ne sont pas toujours nommées pareil selon les flux
  // (snake_case, camelCase, attributs XML @_, objets imbriqués). Ces helpers évitent
  // de perdre les infos et de finir avec des lignes vides côté front.
  function bompNormKey(k) {
    return String(k || '').replace(/^@_/, '').replace(/[^a-z0-9]/gi, '').toLowerCase();
  }

  function bompDeepValues(obj, keys, out = [], seen = new Set()) {
    if (!obj || typeof obj !== 'object' || seen.has(obj)) return out;
    seen.add(obj);
    const wanted = new Set(keys.map(bompNormKey));
    if (Array.isArray(obj)) {
      obj.forEach(v => bompDeepValues(v, keys, out, seen));
      return out;
    }
    for (const [k, v] of Object.entries(obj)) {
      if (wanted.has(bompNormKey(k))) out.push(v);
      bompDeepValues(v, keys, out, seen);
    }
    return out;
  }

  function bompDeepText(obj, keys) {
    for (const v of bompDeepValues(obj, keys)) {
      const got = bompText(v);
      if (got) return got;
    }
    return '';
  }

  function bompDeepDate(obj, keys, fallback = Date.now()) {
    const got = bompDeepText(obj, keys);
    return parseMarketplaceDate(got, fallback);
  }


  function bompKeyHas(k, parts) {
    const nk = bompNormKey(k);
    return (parts || []).some(part => nk.includes(bompNormKey(part)));
  }

  function bompScalarText(v) {
    const got = bompText(v);
    if (!got || got === '[object Object]') return '';
    return got;
  }

  function bompFuzzyText(obj, includeParts, excludeParts = [], validate = null, seen = new Set()) {
    if (!obj || typeof obj !== 'object' || seen.has(obj)) return '';
    seen.add(obj);

    if (Array.isArray(obj)) {
      for (const item of obj) {
        const got = bompFuzzyText(item, includeParts, excludeParts, validate, seen);
        if (got) return got;
      }
      return '';
    }

    for (const [k, v] of Object.entries(obj)) {
      const keyMatches = bompKeyHas(k, includeParts) && !bompKeyHas(k, excludeParts);
      if (keyMatches) {
        const got = bompScalarText(v);
        if (got && (!validate || validate(got, k))) return got;
      }
      const nested = bompFuzzyText(v, includeParts, excludeParts, validate, seen);
      if (nested) return nested;
    }
    return '';
  }


  function bompTrackingUrlIsSafe(rawUrl = '') {
    return isLikelyTrackingUrl(rawUrl) && Boolean(inferCarrierFromTrackingUrl(rawUrl));
  }

  function bompTrackingNumberFromUrl(rawUrl = '') {
    const url = safeTrackingUrl(rawUrl);
    if (!url || !bompTrackingUrlIsSafe(url)) return '';
    const decoded = (() => {
      try { return decodeURIComponent(url); } catch { return url; }
    })();
    const queryMatch = decoded.match(/[?&](?:code|tracking-id|trackingNumber|tracking_number|tracking|tracknum|listeNumerosLT|match|numColis|numeroColis|numeroExpedition|numExpedition|cons|skybillNumber|parcel|parcelno|parcelNumber|shipment|shipmentNumber|awb|waybill|trknbr|reference)=([^&#\s]+)/i);
    if (queryMatch && looksLikeTrackingNumber(queryMatch[1])) return cleanText(queryMatch[1]);

    const pathBits = decoded
      .split(/[/?#&=]+/)
      .map(x => cleanText(x).replace(/[<>'"),.;]+$/g, '').replace(/^[<>'"(]+/g, ''))
      .filter(Boolean)
      .reverse();
    for (const bit of pathBits) {
      if (looksLikeTrackingNumber(bit) && !/^(html?|fr|en|tracking|track|trace|suivi|colis|parcel|shipment|expedition)$/i.test(bit)) return bit;
    }
    return '';
  }

  function bompExtractUrlsFromText(text = '') {
    const raw = String(text || '');
    return (raw.match(/https?:\/\/[^\s<>'"]+/gi) || [])
      .map(u => cleanText(u).replace(/[),.;]+$/g, ''))
      .filter(u => bompTrackingUrlIsSafe(u));
  }

  function bompTrackingCandidateIsSafe(value, ctx = {}) {
    const s = cleanText(value).replace(/\s+/g, '').replace(/^[#:/-]+|[.,;:)/-]+$/g, '');
    if (!looksLikeTrackingNumber(s)) return false;
    const orderId = cleanText(ctx.orderId || '').replace(/\s+/g, '');
    const detailId = cleanText(ctx.orderDetailId || '').replace(/\s+/g, '');
    const messageId = cleanText(ctx.messageId || '').replace(/\s+/g, '');
    if (orderId && s.toUpperCase() === orderId.toUpperCase()) return false;
    if (detailId && s.toUpperCase() === detailId.toUpperCase()) return false;
    if (messageId && s.toUpperCase() === messageId.toUpperCase()) return false;
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return false;
    if (/^\d{1,2}[/.]\d{1,2}[/.]\d{2,4}$/.test(s)) return false;
    // Évite de prendre les IDs techniques Fnac/Darty comme suivis quand aucun indice transporteur n'est présent.
    if (!ctx.carrierHint && looksLikeBompOrderId(s)) return false;
    return true;
  }

  function bompCarrierFromText(text = '') {
    const s = foldStatusText(text);
    return normalizeCarrierCode(s) || inferCarrierFromTrackingUrl(s) || '';
  }

  function bompTrackingFromText(text = '', ctx = {}) {
    const blob = cleanText(text);
    if (!blob) return null;

    const urls = bompExtractUrlsFromText(blob);
    for (const url of urls) {
      const carrier = inferCarrierFromTrackingUrl(url) || bompCarrierFromText(url);
      const num = bompTrackingNumberFromUrl(url);
      if (num && bompTrackingCandidateIsSafe(num, { ...ctx, carrierHint: carrier })) {
        return normalizeTracking({ number: num, url, carrier }, {});
      }
    }

    const carrierHint = bompCarrierFromText(blob);
    const nearKeyword = [
      /(?:n(?:um[ée]ro)?\s*(?:de\s*)?(?:suivi|tracking|colis|exp[ée]dition|transport)|tracking\s*(?:number|id)?|suivi\s*(?:colis)?|colis\s*(?:n[°o])?|awb|waybill)\s*[:#n°\-–]*\s*([A-Z0-9][A-Z0-9._\-]{5,59})/ig,
      /(?:lien|url)\s*(?:de\s*)?(?:suivi|tracking)\s*[:#n°\-–]*\s*([A-Z0-9][A-Z0-9._\-]{5,59})/ig,
    ];
    for (const re of nearKeyword) {
      let m;
      while ((m = re.exec(blob))) {
        const n = cleanText(m[1]).replace(/^[#:/-]+|[.,;:)/-]+$/g, '');
        if (bompTrackingCandidateIsSafe(n, { ...ctx, carrierHint })) {
          return normalizeTracking({ number: n, carrier: carrierHint }, {});
        }
      }
    }

    const carrierSpecific = [];
    if (/ups|united parcel/i.test(blob)) carrierSpecific.push(/\b1Z[A-Z0-9]{10,}\b/ig);
    if (/colissimo|la poste|laposte|courrier suivi/i.test(blob)) carrierSpecific.push(/\b(?:[68][A-Z][A-Z0-9]{9,13}|[A-Z]{2}\d{9}FR|\d[A-Z]\d{11})\b/ig);
    if (/chrono|chronopost/i.test(blob)) carrierSpecific.push(/\b(?:[A-Z]{2}\d{8,12}(?:FR)?|\d{13})\b/ig);
    if (/\bdpd\b|dpd predict/i.test(blob)) carrierSpecific.push(/\b(?:\d{10,16}|[A-Z0-9]{12,18})\b/ig);
    if (/\bgls\b/i.test(blob)) carrierSpecific.push(/\b(?:[A-Z0-9]{8,20})\b/ig);
    if (/dhl/i.test(blob)) carrierSpecific.push(/\b[A-Z0-9]{10,20}\b/ig);
    if (/fedex|federal express/i.test(blob)) carrierSpecific.push(/\b\d{10,22}\b/ig);
    if (/tnt/i.test(blob)) carrierSpecific.push(/\b[A-Z0-9]{8,20}\b/ig);
    if (/mondial|relay/i.test(blob)) carrierSpecific.push(/\b[A-Z0-9]{8,20}\b/ig);
    if (/relais colis|relaiscolis/i.test(blob)) carrierSpecific.push(/\b[A-Z0-9]{8,20}\b/ig);
    if (/colis prive|colispriv/i.test(blob)) carrierSpecific.push(/\b[A-Z0-9]{8,20}\b/ig);
    if (/cchezvous|c chez vous|chezvous/i.test(blob)) carrierSpecific.push(/\b[A-Z0-9]{10,24}\b/ig);
    if (/geodis|calberson/i.test(blob)) carrierSpecific.push(/\b[A-Z0-9]{8,24}\b/ig);

    for (const re of carrierSpecific) {
      let m;
      while ((m = re.exec(blob))) {
        const n = cleanText(m[0]);
        if (bompTrackingCandidateIsSafe(n, { ...ctx, carrierHint })) {
          return normalizeTracking({ number: n, carrier: carrierHint }, {});
        }
      }
    }

    return null;
  }

  function bompDeepTextByRegex(obj, keyRegex, validate = null, maxDepth = 7) {
    const seen = new Set();
    function walk(v, depth) {
      if (!v || typeof v !== 'object' || depth > maxDepth || seen.has(v)) return '';
      seen.add(v);
      if (Array.isArray(v)) {
        for (const item of v) {
          const got = walk(item, depth + 1);
          if (got) return got;
        }
        return '';
      }
      for (const [k, val] of Object.entries(v)) {
        if (keyRegex.test(bompNormKey(k))) {
          const got = bompScalarText(val);
          if (got && (!validate || validate(got, k))) return got;
        }
      }
      for (const val of Object.values(v)) {
        const got = walk(val, depth + 1);
        if (got) return got;
      }
      return '';
    }
    return walk(obj, 0);
  }

  function extractBompTracking(obj, ctx = {}) {
    if (!obj || typeof obj !== 'object') return null;

    const orderId = ctx.orderId || extractBompOrderId(obj);
    const orderDetailId = ctx.orderDetailId || extractBompOrderDetailId(obj);
    const messageId = ctx.messageId || extractBompMessageId(obj);
    const safeCtx = { orderId, orderDetailId, messageId };

    // Important : carrierRaw doit être calculé avant directNumber, car le validateur
    // des numéros utilise l'indice carrierHint. Sinon Node déclenche une TDZ :
    // "Cannot access 'carrierRaw' before initialization".
    const carrierRaw = bompText(
      obj.carrier, obj.carrier_code, obj.carrierCode, obj.carrier_name, obj.carrierName,
      obj.transporteur, obj.transporter, obj.shipping_carrier, obj.shippingCarrier,
      obj.shipping_company, obj.shippingCompany, obj.shipping_method, obj.shippingMethod,
      obj.delivery_carrier, obj.deliveryCarrier, obj.delivery_company, obj.deliveryCompany,
      obj.shipping_type_label, obj.shippingTypeLabel, obj.shipping_type_code, obj.shippingTypeCode
    ) || bompDeepText(obj, [
      'carrier', 'carrier_code', 'carrierCode', 'carrier_name', 'carrierName',
      'transporteur', 'transporter', 'shipping_carrier', 'shippingCarrier',
      'shipping_company', 'shippingCompany', 'shipping_method', 'shippingMethod',
      'delivery_carrier', 'deliveryCarrier', 'delivery_company', 'deliveryCompany',
      'shipping_type_label', 'shippingTypeLabel', 'shipping_type_code', 'shippingTypeCode',
      'logistician', 'shipper', 'courier', 'courier_name', 'courierName'
    ]) || bompDeepTextByRegex(obj, /(carrier|transporteur|transporter|courier|shipper|shippingmethod|deliverycarrier|logistician)/i,
      v => Boolean(normalizeCarrierCode(v))
    );

    const directNumber = bompText(
      obj.tracking_number, obj.trackingNumber, obj.tracking_code, obj.trackingCode, obj.tracking_id, obj.trackingId,
      obj.parcel_number, obj.parcelNumber, obj.package_number, obj.packageNumber, obj.shipment_number, obj.shipmentNumber,
      obj.shipping_number, obj.shippingNumber, obj.shipping_tracking, obj.shippingTracking, obj.shipping_tracking_number, obj.shippingTrackingNumber,
      obj.awb, obj.waybill, obj.colis, obj.no_colis, obj.numero_colis, obj.numero_suivi, obj.numero_expedition
    ) || bompDeepText(obj, [
      'tracking_number', 'trackingNumber', 'tracking_code', 'trackingCode', 'tracking_id', 'trackingId',
      'parcel_number', 'parcelNumber', 'package_number', 'packageNumber', 'shipment_number', 'shipmentNumber',
      'shipping_number', 'shippingNumber', 'shipping_tracking', 'shippingTracking', 'shipping_tracking_number', 'shippingTrackingNumber',
      'awb', 'waybill', 'colis', 'no_colis', 'numero_colis', 'numero_suivi', 'numero_expedition',
      'tracking_ref', 'trackingReference', 'tracking_reference', 'parcel_ref', 'parcelReference', 'shipping_ref'
    ]) || bompDeepTextByRegex(obj, /(tracking|suivi|colis|parcel|shipment|shipping|expedition|waybill|awb).*(number|num|code|id|ref|reference)$/i,
      v => bompTrackingCandidateIsSafe(v, { ...safeCtx, carrierHint: Boolean(carrierRaw) })
    );

    const directUrl = safeTrackingUrl(bompText(
      obj.tracking_url, obj.trackingUrl, obj.shipping_tracking_url, obj.shippingTrackingUrl, obj.url_tracking, obj.tracking_link, obj.trackingLink,
      obj.parcel_url, obj.shipment_url, obj.delivery_url
    ) || bompDeepText(obj, [
      'tracking_url', 'trackingUrl', 'shipping_tracking_url', 'shippingTrackingUrl', 'url_tracking', 'tracking_link', 'trackingLink',
      'parcel_url', 'parcelUrl', 'shipment_url', 'shipmentUrl', 'delivery_url', 'deliveryUrl'
    ]) || bompDeepTextByRegex(obj, /(tracking|suivi|colis|parcel|shipment|shipping|expedition|delivery).*(url|link)$|^(urltracking|trackinglink)$/i,
      v => bompTrackingUrlIsSafe(v)
    ));

    const statusRaw = bompText(
      obj.tracking_status, obj.delivery_status, obj.shipment_status, obj.shipping_status, obj.status, obj.state
    ) || bompDeepText(obj, ['tracking_status', 'delivery_status', 'shipment_status', 'shipping_status', 'status', 'state']);

    const urlNumber = bompTrackingNumberFromUrl(directUrl);
    const carrierFromUrl = inferCarrierFromTrackingUrl(directUrl);
    const carrier = normalizeCarrierCode(carrierRaw, directNumber || urlNumber, directUrl) || carrierFromUrl;
    const number = cleanText(directNumber || urlNumber);

    let structured = null;
    if (number && bompTrackingCandidateIsSafe(number, { ...safeCtx, carrierHint: carrier || directNumber || urlNumber })) {
      structured = normalizeTracking({ number, carrier: carrier || carrierRaw, url: directUrl, status: statusRaw }, {});
    }

    // Les infos Fnac/Darty sont parfois uniquement dans le texte envoyé au client.
    const textBlob = [
      extractBompClientText(obj), extractBompSellerText(obj),
      bompDeepText(obj, ['message', 'message_description', 'description', 'body', 'content', 'comment', 'seller_comment', 'seller_answer']),
      directUrl
    ].filter(Boolean).join(' ');
    const fromText = bompTrackingFromText(textBlob, { ...safeCtx, carrierHint: carrier });

    const fromGeneric = normalizeOrderTracking(obj) || normalizeTracking(obj.tracking || obj.shipment || obj.shipping || obj.delivery, obj);
    let finalTracking = mergeTrackingInfo(mergeTrackingInfo(fromGeneric, structured), fromText);

    // Si on a récupéré un vrai transporteur dans un champ séparé mais que le tracking normalisé n'a gardé que "transporteur".
    const forcedCarrier = normalizeCarrierCode(carrierRaw, finalTracking?.number || number, finalTracking?.url || directUrl) || carrierFromUrl;
    if (finalTracking && forcedCarrier && finalTracking.carrier === 'transporteur') finalTracking.carrier = forcedCarrier;

    if (String(process.env.BOMP_TRACKING_DEBUG || '') === '1' && orderId) {
      console.log(`[bomp/${ctx.providerCode || 'bomp'}] tracking order=${orderId} carrierRaw=${carrierRaw || '-'} url=${directUrl || '-'} number=${number || finalTracking?.number || '-'} -> ${finalTracking ? `${finalTracking.carrier}/${finalTracking.number}/${finalTracking.status}` : 'none'}`);
    }
    return finalTracking;
  }

  function looksLikeBompUuid(v) {
    const s = cleanText(v);
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
  }

  function looksLikeBompOrderId(v) {
    const s = cleanText(v);
    if (!s || looksLikeBompUuid(s)) return false;

    // Exemples réels vus dans les logs :
    // Fnac  : 99R47NSO2UHCS, H2VLSBIJ2WBJE
    // Darty : 89974934_624101-A
    // Important : un incident_id UUID fait 36 caractères et ne doit jamais partir
    // dans <order_fnac_id>, sinon l'API répond maxLength / schema validation.
    if (/^\d{6,12}_\d{1,12}-[A-Z]$/i.test(s)) return true;
    if (/^[A-Z0-9]{8,16}$/i.test(s)) return true;

    // Secours large mais borné : pas de long identifiant UUID, pas de dates/statuts.
    return /^[A-Z0-9][A-Z0-9_]{6,22}(?:-[A-Z])?$/i.test(s)
      && !/^(true|false|yes|no|open|opened|closed|created|accepted|refused|unread|read|archived|client|seller|callcenter)$/i.test(s)
      && !/^\d{4}-\d{2}-\d{2}/.test(s);
  }

  function extractBompOrderId(obj) {
    // BOMP/Fnac-Darty met très souvent le n° de commande dans :
    // <message_referer type="ORDER"><![CDATA[89592381_118817-A]]></message_referer>
    // Sans ce champ, les messages sont bien récupérés mais restent orphelins côté front.
    const refererType = normLower(firstValue(
      obj?.message_referer?.['@_type'], obj?.message_referer?.type, obj?.['@_message_referer_type']
    ));
    const referer = bompText(obj?.message_referer, obj?.messageReferer, obj?.referer, obj?.reference);
    if (referer && (!refererType || /order/.test(refererType)) && looksLikeBompOrderId(referer)) return referer;

    const exact = bompText(
      obj?.['@_order_id'], obj?.['@_order_fnac_id'], obj?.['@_order_reference'], obj?.['@_order_number'],
      obj?.order_fnac_id, obj?.order_id, obj?.orderId, obj?.order_reference, obj?.order_ref, obj?.order_number,
      obj?.order?.order_fnac_id, obj?.order?.order_id, obj?.order?.order_reference, obj?.order?.order_ref, obj?.order?.order_number
    ) || bompDeepText(obj, [
      'order_fnac_id', 'order_id', 'orderId', 'fnac_order_id', 'darty_order_id',
      'order_reference', 'order_ref', 'order_number', 'client_order_id', '@_order_id', '@_order_fnac_id'
    ]);
    if (exact && looksLikeBompOrderId(exact)) return exact;
    return bompFuzzyText(obj, [
      'order_fnac_id', 'orderid', 'order_id', 'fnacorderid', 'dartyorderid', 'orderreference', 'ordernumber', 'orderref', 'messagereferer'
    ], [
      'orderdetail', 'orderline', 'linereference', 'detailid', 'lineid',
      'incident', 'messageid', 'commentid', 'clientordercomment',
      'nbmessage', 'messagecount', 'status', 'state', 'date', 'rate', 'amount', 'price'
    ], looksLikeBompOrderId);
  }

  function extractBompOrderDetailId(obj) {
    return bompText(
      obj?.order_detail_id, obj?.orderDetailId, obj?.order_detail?.order_detail_id,
      obj?.order_detail?.['@_order_detail_id'], obj?.['@_order_detail_id']
    ) || bompDeepText(obj, ['order_detail_id', 'orderDetailId', 'order_detail_fnac_id', 'order_line_id', 'line_id', '@_order_detail_id'])
      || bompFuzzyText(obj, ['orderdetailid', 'lineid'], ['orderid']);
  }


  function extractBompEan(obj) {
    // Fnac/Darty/BOMP peut placer l'EAN/Gencod dans les lignes commande,
    // les détails produit, ou parfois dans offer_seller_id lorsque le vendeur
    // utilise l'EAN comme SKU. On accepte uniquement une vraie valeur EAN
    // 8/12/13/14 chiffres, jamais un ID Fnac, un order_id ou un SKU quelconque.
    if (!obj || typeof obj !== 'object') return '';

    const exactKeys = [
      'ean', 'ean13', 'ean_13', 'gencod', 'gtin', 'barcode', 'bar_code', 'code_barre',
      'product_ean', 'productEAN', 'product_gtin', 'productGtin', 'product_barcode',
      'article_ean', 'item_ean', 'order_detail_ean', 'order_line_ean', 'line_ean',
      'product_reference', 'productReference', 'product_ref', 'productRef'
    ];

    const directCandidates = [
      obj.ean, obj.ean13, obj.ean_13, obj.gencod, obj.gtin, obj.barcode, obj.bar_code, obj.code_barre,
      obj.product_ean, obj.productEAN, obj.product_gtin, obj.productGtin, obj.product_barcode,
      obj.product?.ean, obj.product?.ean13, obj.product?.gtin, obj.product?.gencod, obj.product?.barcode,
      obj.article?.ean, obj.item?.ean, obj.order_detail?.ean, obj.order_line?.ean
    ];
    for (const v of directCandidates) {
      const got = looksLikeEan(v);
      if (got) return got;
    }

    // Recherche profonde mais priorisée : d'abord les clés explicitement EAN/Gencod/GTIN.
    for (const v of bompDeepValues(obj, exactKeys)) {
      const got = looksLikeEan(v);
      if (got) return got;
    }

    // Certains retours BOMP exposent les lignes dans order_detail/order_details/order_lines.
    // On scanne ces blocs pour récupérer l'EAN sans dépendre du nom exact du champ.
    const lineBlocks = [
      ...oneOrMany(obj.order_detail), ...oneOrMany(obj.order_details?.order_detail),
      ...oneOrMany(obj.order_line), ...oneOrMany(obj.order_lines?.order_line),
      ...oneOrMany(obj.product), ...oneOrMany(obj.products?.product),
      ...oneOrMany(obj.item), ...oneOrMany(obj.items?.item),
      ...collectNodes(obj, ['order_detail', 'order_line', 'product', 'item', 'article'])
    ];
    for (const block of lineBlocks) {
      const got = firstOrderEan(block);
      if (got) return got;
    }

    // Dernier secours : certains vendeurs mettent l'EAN dans leur référence offre/SKU.
    // On n'accepte que si la valeur contient un vrai EAN, sinon on ne renvoie rien.
    const skuKeys = [
      'offer_seller_id', 'offerSellerId', 'seller_sku', 'sellerSku', 'sku', 'reference',
      'seller_reference', 'sellerReference', 'shop_reference', 'merchant_sku'
    ];
    for (const v of bompDeepValues(obj, skuKeys)) {
      const got = looksLikeEan(v);
      if (got) return got;
    }

    return '';
  }

  function extractBompMessageId(obj) {
    return bompText(obj?.message_id, obj?.messageId, obj?.id, obj?.['@_id'], obj?.['@_message_id'])
      || bompDeepText(obj, ['message_id', 'messageId', 'last_message_id', 'thread_id', 'discussion_id', '@_message_id'])
      || bompFuzzyText(obj, ['messageid', 'threadid', 'discussionid'], ['orderid']);
  }

  function extractBompClientText(obj) {
    // Ne jamais utiliser un #text imbriqué en fallback général : dans les messages BOMP,
    // message_referer possède aussi un #text, qui est le numéro de commande. C'est ce
    // qui affichait 89592381_118817-A comme si le client avait écrit ce message.
    const direct = bompText(
      obj?.message_description, obj?.messageDescription, obj?.client_comment, obj?.customer_message,
      obj?.client_message, obj?.opening_message, obj?.description, obj?.body, obj?.content,
      obj?.text, obj?.message_text, obj?.comment_text, obj?.comment,
      typeof obj?.message === 'string' ? obj.message : '',
      obj?.['#text']
    );
    if (direct && !looksLikeBompOrderId(direct)) return direct;

    const exact = bompDeepText(obj, [
      'message_description', 'messageDescription', 'client_comment', 'customer_message',
      'client_message', 'opening_message', 'description', 'body', 'content',
      'message_text', 'comment_text', 'comment'
    ]);
    if (exact && !looksLikeBompOrderId(exact)) return exact;

    const fuzzy = bompFuzzyText(obj, [
      'messagedescription', 'clientcomment', 'customermessage', 'clientmessage',
      'openingmessage', 'description', 'body', 'content', 'messagetext', 'commenttext'
    ], ['referer', 'reference', 'order', 'reply', 'answer', 'id', 'date', 'status', 'state']);
    return fuzzy && !looksLikeBompOrderId(fuzzy) ? fuzzy : '';
  }

  function extractBompSellerText(obj) {
    return bompText(obj?.comment_reply, obj?.seller_comment, obj?.seller_answer, obj?.reply, obj?.answer)
      || bompDeepText(obj, ['comment_reply', 'seller_comment', 'seller_answer', 'reply', 'answer'])
      || bompFuzzyText(obj, ['sellercomment', 'selleranswer', 'commentreply', 'reply', 'answer'], ['id', 'date', 'status', 'state']);
  }

  function bompBoolText(v) {
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    const s = String(v ?? '').trim();
    if (/^(true|1|yes|oui)$/i.test(s)) return 'TRUE';
    if (/^(false|0|no|non)$/i.test(s)) return 'FALSE';
    return s.toUpperCase();
  }

  function bompElementXml(key, value) {
    if (value === undefined || value === null || value === '') return '';

    // BOMP/Fnac-Darty est strict : les booléens XML sont souvent en TRUE/FALSE.
    // Exemples : message_archived, waiting_for_seller_answer.
    if (typeof value === 'boolean' || ['message_archived', 'waiting_for_seller_answer'].includes(key)) {
      return `  <${key}>${xmlEscape(bompBoolText(value))}</${key}>`;
    }

    // Le schéma refuse <message_from_types>CLIENT</message_from_types> :
    // c'est un élément composé et l'élément enfant attendu est <from_type>.
    if (key === 'message_from_types') {
      const vals = (Array.isArray(value) ? value : String(value).split(','))
        .map(v => String(v || '').trim().toUpperCase())
        .filter(Boolean);
      if (!vals.length) return '';
      return `  <message_from_types>\n${vals.map(v => `    <from_type>${xmlEscape(v)}</from_type>`).join('\n')}\n  </message_from_types>`;
    }

    if (Array.isArray(value)) {
      return value.map(item => `  <${key}>${xmlEscape(item)}</${key}>`).join('\n');
    }

    return `  <${key}>${xmlEscape(value)}</${key}>`;
  }

  function bompOrderedElements(operation, elements = {}) {
    const order = {
      messages_query: [
        'paging', 'date', 'message_type', 'message_archived', 'message_state',
        'message_id', 'order_fnac_id', 'offer_fnac_id', 'offer_seller_id',
        'sort_by', 'message_from_types'
      ],
      client_order_comments_query: ['paging', 'date', 'rate', 'client_order_comment_id', 'order_fnac_id'],
      orders_query: ['paging', 'date', 'sort_by', 'product_fnac_id', 'offer_fnac_id', 'offer_seller_id', 'state', 'states', 'order_fnac_id', 'orders_fnac_id'],
      incidents_query: ['paging', 'date', 'status', 'type', 'types', 'incident_id', 'incidents_id', 'closed_statuses', 'closed_status', 'waiting_for_seller_answer', 'opened_by', 'closed_by', 'sort_by', 'order', 'orders'],
    }[operation] || [];

    const keys = [
      ...order.filter(k => Object.prototype.hasOwnProperty.call(elements, k)),
      ...Object.keys(elements).filter(k => !order.includes(k)),
    ];

    const inner = keys
      .map(k => bompElementXml(k, elements[k]))
      .filter(Boolean)
      .join('\n');

    return inner || '  <paging>1</paging>';
  }

  function bompQueryXml(provider, token, operation, elements = {}, resultsCount = 100) {
    // Si une requête précédente a forcé une ré-authentification, on prend
    // automatiquement le dernier token en cache plutôt que l'ancien token local.
    const activeToken = tokens.get(provider.code)?.value || token;
    const inner = bompOrderedElements(operation, elements);
    const attrs = resultsCount ? ` results_count="${xmlEscape(resultsCount)}"` : '';
    return authedRequest(provider, activeToken, operation, inner, attrs);
  }

  function mergeClaimDetails(base, detail) {
    if (!base || !detail) return base;
    if (!base.orderId && detail.orderId) base.orderId = detail.orderId;
    if ((!base.customer || base.customer === 'Client') && detail.customer && detail.customer !== 'Client') base.customer = detail.customer;
    if (!base.product && detail.product) base.product = detail.product;
    if (!base.ean && detail.ean) base.ean = detail.ean;
    if (detail._ctx?.ean && !base._ctx?.ean) base._ctx = { ...(base._ctx || {}), ean: detail._ctx.ean };
    if (detail.tracking) base.tracking = mergeTrackingInfo(base.tracking, detail.tracking);
    if (isBadSubject(base.subject) && detail.subject && !isBadSubject(detail.subject)) base.subject = detail.subject;
    // Le statut marketplace le plus précis doit survivre aux fusions message/incident.
    if (detail.marketplaceStatus || detail.statusRaw || detail._ctx?.marketplaceStatus || detail._ctx?.rawStatus) {
      applyMarketplaceStatus(base, detail.marketplaceStatus || detail.statusRaw || detail._ctx?.marketplaceStatus || detail._ctx?.rawStatus);
    } else if (detail.status === 'resolu') {
      base.status = 'resolu';
      base._ctx = { ...(base._ctx || {}), closedByMarketplace: true };
    }
    if ((!base.messages || !base.messages.length) && detail.messages?.length) base.messages = detail.messages;
    else base.messages = dedupeMessages([...(base.messages || []), ...(detail.messages || [])]);
    base.updatedAt = Math.max(Number(base.updatedAt || 0), Number(detail.updatedAt || 0)) || base.updatedAt || detail.updatedAt;
    base.dueAt = computeDueAt(base.messages || []);
    base._ctx = { ...(base._ctx || {}), ...(detail._ctx || {}), orderId: base.orderId || detail.orderId || base._ctx?.orderId };
    if (isClaimClosedByMarketplace(base)) {
      base.status = 'resolu';
      base._ctx.closedByMarketplace = true;
    }
    return base;
  }

  function mergeClaimsByIncidentOrOrder(claims) {
    const out = [];
    const byKey = new Map();
    for (const claim of claims || []) {
      const key = claim?._ctx?.incidentId
        ? `incident:${claim._ctx.incidentId}`
        : claim?.orderId
          ? `order:${claim.orderId}`
          : claim?.id;
      if (!key || !byKey.has(key)) {
        byKey.set(key, claim);
        out.push(claim);
      } else {
        mergeClaimDetails(byKey.get(key), claim);
      }
    }
    return out;
  }

  function extractBompCustomerInfo(obj) {
    const first = bompDeepText(obj, ['client_firstname', 'buyer_firstname', 'customer_firstname', 'firstname', 'first_name']);
    const last = bompDeepText(obj, ['client_lastname', 'buyer_lastname', 'customer_lastname', 'lastname', 'last_name']);
    const name = sanitizeCustomerName([first, last].filter(Boolean).join(' '));

    const customerId = cleanText(
      bompText(
        obj?.client_id, obj?.customer_id, obj?.buyer_id,
        obj?.client?.id, obj?.customer?.id, obj?.buyer?.id,
        obj?.client?.client_id, obj?.customer?.customer_id, obj?.buyer?.buyer_id
      )
      || bompDeepText(obj, [
        'client_id', 'customer_id', 'buyer_id',
        'client_number', 'customer_number', 'buyer_number',
        'client_reference', 'customer_reference', 'customer_ref',
        'account_id', 'member_id', 'user_id'
      ])
    );

    const email = cleanText(bompDeepText(obj, ['client_email', 'customer_email', 'buyer_email', 'email', 'mail']));
    // IMPORTANT Darty : ne jamais chercher le champ générique "name".
    // Il apparaît aussi dans <attachment><name>photo.jpg</name></attachment> et finissait en nom client.
    const labelCandidate = bompDeepText(obj, ['customer_name', 'buyer_name', 'client_name'])
      || bompFuzzyText(obj,
        ['customername', 'buyername', 'clientname'],
        ['attachment', 'file', 'document', 'piecejointe', 'filename'],
        v => !isBadCustomerName(v)
      );
    const label = name
      || sanitizeCustomerName(labelCandidate)
      || sanitizeCustomerName(customerId)
      || sanitizeCustomerName(email);

    return {
      customer: sanitizeCustomerName(label),
      customerId,
      email,
    };
  }

  function mapOrderInfo(o) {
    const orderId = extractBompOrderId(o);
    if (!orderId) return null;
    const customerInfo = extractBompCustomerInfo(o);
    const product = bompDeepText(o, ['product_name', 'product_label', 'product_title', 'title', 'description'])
      || bompDeepText(o, ['offer_seller_id', 'offer_fnac_id', 'seller_sku', 'sku']);
    const ean = extractBompEan(o);
    if (String(process.env.BOMP_EAN_DEBUG || '') === '1') {
      console.log(`[bomp/order] ean order=${orderId} ean=${ean || '-'} product=${cleanText(product) || '-'}`);
    }
    return {
      orderId,
      customer: cleanText(customerInfo.customer),
      customerId: cleanText(customerInfo.customerId),
      product: cleanText(product),
      ean: cleanText(ean),
      tracking: extractBompTracking(o, { providerCode: 'bomp-order', orderId })
    };
  }

  function enrichClaimFromOrderInfo(claim, infoByOrderId) {
    const info = claim?.orderId ? infoByOrderId.get(claim.orderId) : null;
    if (!info) return claim;
    if ((!claim.customer || claim.customer === 'Client') && info.customer) claim.customer = info.customer;
    if (!claim.customerId && info.customerId) claim.customerId = info.customerId;
    if (!claim.product && info.product) claim.product = info.product;
    if (!claim.ean && info.ean) claim.ean = info.ean;
    if (info.tracking) claim.tracking = mergeTrackingInfo(claim.tracking, info.tracking);
    claim._ctx = { ...(claim._ctx || {}), orderId: claim.orderId, ...(info.ean ? { ean: info.ean } : {}) };
    return claim;
  }

  function uniqueBompNodes(nodes) {
    const seen = new Set();
    return (nodes || []).filter(x => {
      if (!x || typeof x !== 'object') return false;
      const key = JSON.stringify(x).slice(0, 700);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function embeddedBompMessages(obj) {
    return uniqueBompNodes([
      ...oneOrMany(obj?.message),
      ...oneOrMany(obj?.messages?.message),
      ...oneOrMany(obj?.thread?.message),
      ...oneOrMany(obj?.conversation?.message),
      ...oneOrMany(obj?.discussion?.message),
      ...oneOrMany(obj?.comment),
      ...oneOrMany(obj?.comments?.comment),
      ...collectNodes(obj, ['message', 'comment', 'client_order_comment', 'discussion_message'])
    ]);
  }

  function extractBompMessageFromType(m) {
    // Dans le XML BOMP réel :
    // <message_from type="CLIENT"><![CDATA[DOMINIQUE]]></message_from>
    // Si on lit seulement le texte "DOMINIQUE", on classe le message comme vendeur.
    // Il faut donc prioriser l'attribut type.
    return firstValue(
      m?.message_from?.['@_type'], m?.message_from?.type, m?.message_from_type, m?.['@_message_from_type'],
      m?.from?.['@_type'], m?.from?.type, m?.from_type, m?.sender_type,
      m?.['@_from_type'], m?.['@_sender_type'], m?.author_type,
      m?.is_customer ? 'CLIENT' : '',
      m?.is_seller ? 'SELLER' : '',
      m?.message_from, m?.from, m?.author, m?.created_by, m?.origin, m?.source
    );
  }

  function extractBompMessageFromLabel(m) {
    return cleanText(firstValue(
      m?.message_from?.['#text'], m?.message_from?.value, m?.message_from,
      m?.from?.['#text'], m?.from?.value, m?.from, m?.author
    ));
  }

  function mapEmbeddedBompMessage(m, defaultAuthor = 'client') {
    const attachments = normalizeInboundAttachments(m);
    return {
      from: parseBompAuthor(extractBompMessageFromType(m) || defaultAuthor),
      at: parseBompDate(
        m['@_date'], m.date, m.created_at, m.createdAt, m.updated_at, m.updatedAt,
        m.sent_at, m.creation_date, m.modification_date
      ),
      text: extractBompClientText(m),
      ...(attachments.length ? { attachments } : {})
    };
  }

  function dedupeMessages(messages) {
    const seen = new Set();
    return (messages || [])
      .map(m => {
        const attachments = Array.isArray(m?.attachments) ? m.attachments : normalizeInboundAttachments(m);
        const text = cleanText(m?.text || m?.body || m?.message || m?.description || m?.content || '');
        return {
          from: m?.from || parseBompAuthor(m?.author || m?.message_from || m?.from_type || m?.['@_from']),
          at: Number(m?.at) || parseBompDate(m?.rawAt || m?.date || m?.created_at || m?.updated_at),
          text,
          ...(attachments.length ? { attachments } : {})
        };
      })
      .filter(m => m && (m.text || (m.attachments && m.attachments.length)))
      .filter(m => {
        const attKey = (m.attachments || []).map(a => [a.id, a.url, a.name, a.size].filter(Boolean).join(':')).join(',');
        const key = `${m.from}|${m.at}|${m.text}|${attKey}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => a.at - b.at);
  }

  function findNewestClientMessage(claim) {
    return [...(claim.messages || [])].reverse().find(m => m.from === 'client' && m.text);
  }

  function mergeBompMessagesIntoIncidents(incidents, messages) {
    const msgByOrder = new Map();
    for (const msg of messages) {
      const orderId = msg._ctx?.orderId || msg.orderId;
      if (!orderId) continue;
      if (!msgByOrder.has(orderId)) msgByOrder.set(orderId, []);
      msgByOrder.get(orderId).push(msg);
    }

    for (const inc of incidents) {
      const orderId = inc._ctx?.orderId || inc.orderId;
      const linked = orderId ? (msgByOrder.get(orderId) || []) : [];
      if (!linked.length) {
        inc.messages = dedupeMessages(inc.messages);
        continue;
      }

      const linkedMessages = linked.flatMap(m => m.messages || []);
      inc.messages = dedupeMessages([...(inc.messages || []), ...linkedMessages]);

      const best = [...linked]
        .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
        .find(m => m._ctx?.messageId);
      if (best?._ctx?.messageId) {
        inc._ctx.messageId = best._ctx.messageId;
        inc._ctx.messageSubject = best.subject || inc.subject;
      }
    }
    return incidents;
  }

  function mapIncident(provider, it) {
    const msgs = dedupeMessages(embeddedBompMessages(it).map(m => mapEmbeddedBompMessage(m)));

    const incidentId = bompText(it['@_id'], it.incident_id, it.id, it.incidentId) || bompDeepText(it, [
      'incident_id', 'incidentId', 'claim_id', 'claimId', 'case_id', 'caseId', 'id'
    ]);
    const orderId = extractBompOrderId(it);
    const orderDetailId = extractBompOrderDetailId(it);
    const fallbackText = findNewestClientMessage({ messages: msgs })?.text || bompText(it.description, it.message, it.comment) || bompDeepText(it, [
      'customer_message', 'client_message', 'opening_message', 'description', 'comment', 'body', 'text'
    ]);
    const subject = normalizeSubject(
      firstReadableSubject(
        it['@_reason'], it.reason, it.reason_label, it.incident_reason, it.incident_reason_label,
        it.type, it.incident_type, it.incident_type_label, it.subject, it.title,
        bompDeepText(it, ['reason_label', 'incident_reason', 'incident_reason_label', 'incident_type_label', 'subject', 'title', 'motif'])
      ),
      fallbackText
    );
    const statusRaw = firstValue(it['@_status'], it.status, it.incident_status, it.state, it.status_label, it.state_label) || bompDeepText(it, [
      'status', 'incident_status', 'state', 'state_label', 'status_label', 'incident_status_label'
    ]);
    const waitingForSeller = truthyBomp(firstValue(
      it.waiting_for_seller_answer, it['@_waiting_for_seller_answer'],
      it.waiting_seller_answer, it.seller_answer_required, it.answer_required,
      bompDeepText(it, ['waiting_for_seller_answer', 'waiting_seller_answer', 'seller_answer_required', 'answer_required'])
    ));
    const openedByRaw = firstValue(it.opened_by, it['@_opened_by'], it.created_by, it.author, it.from) || bompDeepText(it, [
      'opened_by', 'created_by', 'author', 'from', 'sender_type'
    ]);
    const openedAt = parseBompDate(
      it['@_created_at'], it.created_at, it.date_created, it.opened_at, it.date,
      bompDeepText(it, ['created_at', 'createdAt', 'date_created', 'opening_date', 'opened_at', 'date'])
    );
    const updatedAt = parseBompDate(
      it['@_updated_at'], it.updated_at, it.date_updated, it.modified_at, it.last_update,
      bompDeepText(it, ['updated_at', 'updatedAt', 'date_updated', 'modified_at', 'last_update', 'last_message_date']),
      openedAt
    );

    return makeClaim(provider.code, {
      providerType: 'bomp',
      id: incidentId || orderId || Math.random().toString(36).slice(2),
      customer: extractBompCustomerInfo(it).customer
        || sanitizeCustomerName(bompText(it['@_customer'], it.customer, it.buyer, it.client, it.client_id))
        || sanitizeCustomerName(bompDeepText(it, ['customer_name', 'buyer_name', 'client_name', 'client_id', 'buyer_id']))
        || 'Client',
      customerId: extractBompCustomerInfo(it).customerId,
      subject,
      orderId,
      product: bompText(it['@_product'], it.product_name, it.product, it.offer_seller_id, it.offer_fnac_id) || bompDeepText(it, [
        'product', 'product_name', 'product_label', 'product_title', 'title', 'offer_seller_id', 'offer_fnac_id', 'seller_sku', 'sku'
      ]),
      ean: extractBompEan(it),
      priority: 'haute',
      status: normalizeMarketplaceStatus(statusRaw, 'nouveau'),
      marketplaceStatus: statusRaw,
      updatedAt,
      dueAt: computeDueAt(msgs.length ? msgs : [{ from: 'client', at: openedAt }]),
      messages: msgs,
      tracking: extractBompTracking(it, { providerCode: provider.code, orderId, orderDetailId, messageId: extractBompMessageId(it) }),
      ctx: {
        kind: 'incident',
        incidentId,
        orderId,
        orderDetailId,
        ...(extractBompEan(it) ? { ean: extractBompEan(it) } : {}),
        messageId: extractBompMessageId(it),
        rawType: bompText(it.type, it.incident_type, it.reason) || bompDeepText(it, ['type', 'incident_type', 'reason', 'motif']),
        openedAt,
        updatedAt,
        openedBy: parseBompAuthor(openedByRaw),
        waitingForSeller,
        marketplaceStatus: statusRaw,
        rawStatus: statusRaw,
        closedByMarketplace: isClosedMarketplaceStatus(statusRaw),
        // Ne pas considérer "un client a écrit un jour" comme "à répondre".
        // Pour Fnac/Darty, la source fiable est waiting_for_seller_answer ou le dernier message,
        // sauf si l'incident est clôturé sur la marketplace.
        needsReply: waitingForSeller && !isClosedMarketplaceStatus(statusRaw),
      },
    });
  }

  function mapMessage(provider, m, defaultOrderId = '') {
    const id = extractBompMessageId(m);
    const orderId = extractBompOrderId(m) || defaultOrderId;
    const text = extractBompClientText(m);
    const author = parseBompAuthor(extractBompMessageFromType(m) || 'CLIENT');
    const fromLabel = extractBompMessageFromLabel(m);
    const at = parseBompDate(
      m.date, m.created_at, m.createdAt, m.updated_at, m.updatedAt, m.sent_at, m.creation_date,
      bompDeepText(m, ['date', 'created_at', 'createdAt', 'updated_at', 'updatedAt', 'sent_at', 'creation_date'])
    );
    return makeClaim(provider.code, {
      providerType: 'bomp',
      id: id || orderId || Math.random().toString(36).slice(2),
      customer: extractBompCustomerInfo(m).customer
        || sanitizeCustomerName(bompText(m.client_id, m.customer, m.buyer))
        || sanitizeCustomerName(bompDeepText(m, ['customer_name', 'buyer_name', 'client_name', 'client_id', 'buyer_id']))
        || (author === 'client' && fromLabel && !/^(CLIENT|CALLCENTER|FNAC|DARTY)$/i.test(fromLabel) ? sanitizeCustomerName(fromLabel) : '')
        || 'Client',
      customerId: extractBompCustomerInfo(m).customerId,
      subject: normalizeSubject(firstReadableSubject(
        m.subject, m.message_subject, m.type,
        bompDeepText(m, ['subject', 'message_subject', 'reason', 'reason_label', 'motif', 'type'])
      ), text),
      orderId,
      product: bompText(m.offer_seller_id, m.offer_fnac_id, m.product_name) || bompDeepText(m, [
        'product', 'product_name', 'product_label', 'product_title', 'offer_seller_id', 'offer_fnac_id', 'seller_sku', 'sku'
      ]),
      ean: extractBompEan(m),
      priority: 'moyenne',
      status: normalizeMarketplaceStatus(scalarFirst(m.message_state, m.state), String(m.message_state || m.state || '').toLowerCase().includes('read') ? 'attente' : 'nouveau'),
      marketplaceStatus: scalarFirst(m.message_state, m.state),
      updatedAt: at,
      messages: (text || normalizeInboundAttachments(m).length)
        ? [{ from: author, at, text, attachments: normalizeInboundAttachments(m) }]
        : [],
      tracking: extractBompTracking(m, { providerCode: provider.code, orderId, messageId: id }),
      ctx: { kind: 'message', messageId: id, orderId, ...(extractBompEan(m) ? { ean: extractBompEan(m) } : {}), marketplaceStatus: scalarFirst(m.message_state, m.state), rawStatus: scalarFirst(m.message_state, m.state), needsReply: author === 'client' },
    });
  }

  function mapClientOrderComment(provider, c, defaultOrderId = '') {
    const commentId = bompText(c.client_order_comment_id, c.comment_id, c.id, c['@_id']) || bompDeepText(c, [
      'client_order_comment_id', 'comment_id', 'id'
    ]);
    const orderId = extractBompOrderId(c) || defaultOrderId;
    const clientText = extractBompClientText(c);
    const sellerReply = extractBompSellerText(c);
    const at = parseBompDate(
      c.date, c.created_at, c.createdAt, c.updated_at, c.updatedAt, c.creation_date,
      bompDeepText(c, ['date', 'created_at', 'createdAt', 'updated_at', 'updatedAt', 'creation_date'])
    );
    const messages = [];
    const attachments = normalizeInboundAttachments(c);
    if (clientText || attachments.length) messages.push({ from: 'client', at, text: clientText, attachments });
    if (sellerReply) messages.push({ from: 'seller', at, text: sellerReply });

    return makeClaim(provider.code, {
      providerType: 'bomp',
      id: commentId || orderId || Math.random().toString(36).slice(2),
      customer: extractBompCustomerInfo(c).customer
        || sanitizeCustomerName(bompText(c.client_id, c.customer, c.buyer))
        || sanitizeCustomerName(bompDeepText(c, ['customer_name', 'buyer_name', 'client_name', 'client_id', 'buyer_id']))
        || 'Client',
      customerId: extractBompCustomerInfo(c).customerId,
      subject: normalizeSubject(firstReadableSubject(
        c.subject, c.type, bompDeepText(c, ['subject', 'message_subject', 'reason', 'reason_label', 'motif', 'type'])
      ), clientText),
      orderId,
      product: bompText(c.offer_seller_id, c.offer_fnac_id, c.product_name) || bompDeepText(c, [
        'product', 'product_name', 'product_label', 'product_title', 'offer_seller_id', 'offer_fnac_id', 'seller_sku', 'sku'
      ]),
      ean: extractBompEan(c),
      priority: 'moyenne',
      status: sellerReply ? 'attente' : 'nouveau',
      updatedAt: at,
      messages,
      tracking: extractBompTracking(c, { providerCode: provider.code, orderId, messageId: commentId }),
      ctx: {
        kind: 'order_comment',
        commentId,
        orderId,
        ...(extractBompEan(c) ? { ean: extractBompEan(c) } : {}),
        needsReply: Boolean(clientText && !sellerReply),
      },
    });
  }

  function mapClientOrderCommentToNote(provider, c, defaultOrderId = '') {
    const commentId = bompText(c.client_order_comment_id, c.comment_id, c.id, c['@_id']) || bompDeepText(c, [
      'client_order_comment_id', 'comment_id', 'id'
    ]);
    const orderId = extractBompOrderId(c) || defaultOrderId;
    const rating = normalizeRatingValue(
      bompText(c.rate, c.rating, c.note, c.score, c.mark, c.grade)
      || bompDeepText(c, ['rate', 'rating', 'note', 'score', 'mark', 'grade'])
    );
    const clientText = extractBompClientText(c)
      || bompDeepText(c, ['client_order_comment', 'order_comment', 'review', 'avis', 'comment_description']);
    const sellerReply = extractBompSellerText(c);
    const at = parseBompDate(
      c.date, c.created_at, c.createdAt, c.updated_at, c.updatedAt, c.creation_date,
      bompDeepText(c, ['date', 'created_at', 'createdAt', 'updated_at', 'updatedAt', 'creation_date'])
    );
    const product = bompText(c.offer_seller_id, c.offer_fnac_id, c.product_name) || bompDeepText(c, [
      'product', 'product_name', 'product_label', 'product_title', 'offer_seller_id', 'offer_fnac_id', 'seller_sku', 'sku'
    ]);
    const ean = extractBompEan(c);

    return makeProductNote(provider.code, {
      providerType: 'bomp',
      id: commentId || orderId,
      orderId,
      customer: extractBompCustomerInfo(c).customer
        || sanitizeCustomerName(bompText(c.client_id, c.customer, c.buyer))
        || sanitizeCustomerName(bompDeepText(c, ['customer_name', 'buyer_name', 'client_name', 'client_id', 'buyer_id']))
        || 'Client',
      product,
      ean,
      rating,
      comment: clientText,
      reply: sellerReply,
      at,
      visible: true,
      source: 'bomp_client_order_comments',
      ctx: { commentId, orderId }
    });
  }

  return {
    async authCheck(provider) {
      tokens.delete(provider.code);
      const token = await getToken(provider, { force: true });
      return {
        ok: Boolean(token),
        code: provider.code,
        label: provider.label,
        type: 'bomp',
        apiBase: provider.apiBase,
        hasToken: Boolean(token),
        tokenPreview: token ? `${String(token).slice(0, 6)}…${String(token).slice(-4)}` : ''
      };
    },

    async fetchProductNotes(provider, options = {}) {
      const token = await getToken(provider);
      const notes = [];
      const errors = [];
      const fast = options.fast !== false;
      const pageSize = positiveInt(options.pageSize || process.env.BOMP_NOTES_PAGE_SIZE, fast ? 50 : 100, 1, 500);
      const maxPages = positiveInt(options.pages || process.env.BOMP_NOTES_MAX_PAGES, fast ? 1 : 3, 1, 50);
      const enrichRequested = options.enrich === true || parseBoolFlag(process.env.BOMP_NOTES_ENRICH, !fast);
      const enrichLimit = enrichRequested ? positiveInt(options.enrichLimit || process.env.BOMP_NOTES_ENRICH_LIMIT, fast ? 20 : 50, 0, 500) : 0;
      const enrichConcurrency = positiveInt(options.enrichConcurrency || process.env.BOMP_NOTES_ENRICH_CONCURRENCY, fast ? 4 : 6, 1, 20);

      async function safeQuery(operation, xml, label = operation) {
        try {
          return await postXml(provider, operation, xml);
        } catch (e) {
          errors.push({ operation: label, message: e.message, statusCode: e.statusCode });
          console.warn(`[bomp/${provider.code}] ${label} ignoré pour les notes : ${e.message}`);
          return null;
        }
      }

      for (let page = 1; page <= maxPages; page++) {
        const response = await safeQuery(
          'client_order_comments_query',
          bompQueryXml(provider, token, 'client_order_comments_query', { paging: page }, pageSize),
          `client_order_comments_query/page:${page}`
        );
        const root = response?.client_order_comments_query_response || response?.client_order_comments || response || {};
        const comments = response ? extractBompNodes(root, ['client_order_comment', 'comment']) : [];
        notes.push(...comments.map(c => mapClientOrderCommentToNote(provider, c)).filter(productNoteIsUsable));
        if (!comments.length || comments.length < pageSize) break;
      }

      const orderIds = enrichLimit > 0
        ? [...new Set(notes.map(n => n.orderId).filter(Boolean))].slice(0, enrichLimit)
        : [];
      const orderInfoById = new Map();
      await mapLimit(orderIds, enrichConcurrency, async (orderId) => {
        const orderResponse = await safeQuery(
          'orders_query',
          bompQueryXml(provider, token, 'orders_query', { paging: 1, order_fnac_id: orderId }, 20),
          `orders_query/order_fnac_id:${orderId}`
        );
        const root = orderResponse?.orders_query_response || orderResponse?.orders || orderResponse || {};
        const orders = orderResponse ? extractBompNodes(root, ['order']) : [];
        for (const info of orders.map(mapOrderInfo).filter(Boolean)) orderInfoById.set(info.orderId, info);
      });

      for (const note of notes) {
        const info = note.orderId ? orderInfoById.get(note.orderId) : null;
        if (!info) continue;
        if ((!note.customer || note.customer === 'Client') && info.customer) note.customer = info.customer;
        if (!note.product && info.product) note.product = info.product;
        if (!note.ean && info.ean) note.ean = info.ean;
      }

      if (String(process.env.BOMP_DEBUG || '') === '1') {
        console.log(`[bomp/${provider.code}] notes comments=${notes.length}, ordersEnriched=${orderInfoById.size}, errors=${errors.length}`);
      }
      return dedupeProductNotes(notes);
    },

    async fetchThread(provider, ctxOrClaim = {}) {
      const token = await getToken(provider);
      const errors = [];
      const baseClaim = ctxOrClaim?.claim
        ? (typeof structuredClone === 'function' ? structuredClone(ctxOrClaim.claim) : JSON.parse(JSON.stringify(ctxOrClaim.claim)))
        : null;

      let claim = baseClaim || null;
      let orderId = scalarFirst(ctxOrClaim?.orderId, ctxOrClaim?.order_fnac_id, ctxOrClaim?.order, claim?.orderId);
      const incidentId = scalarFirst(ctxOrClaim?.incidentId, ctxOrClaim?.claim?.incidentId, claim?._ctx?.incidentId);
      const threadPageSize = positiveInt(process.env.BOMP_THREAD_PAGE_SIZE, 100, 1, 500);
      const threadMaxPages = positiveInt(process.env.BOMP_THREAD_MAX_PAGES, 10, 1, 50);
      let useThreadFromTypes = parseBoolFlag(process.env.BOMP_THREAD_USE_MESSAGE_FROM_TYPES, true);

      async function safeQuery(operation, xml, label = operation) {
        try {
          return await postXml(provider, operation, xml);
        } catch (e) {
          errors.push({ operation: label, message: e.message, statusCode: e.statusCode });
          if (/message_from_types|message_from_type|from_type/i.test(String(e.message || ''))) useThreadFromTypes = false;
          console.warn(`[bomp/${provider.code}] détail ${label} ignoré : ${e.message}`);
          return null;
        }
      }

      if (!orderId && incidentId) {
        const detailResponse = await safeQuery(
          'incidents_query',
          bompQueryXml(provider, token, 'incidents_query', { paging: 1, incident_id: incidentId }, 20),
          `incidents_query/detail:${incidentId}`
        );
        const dr = detailResponse?.incidents_query_response || detailResponse?.incidents || detailResponse || {};
        const detailIncidents = detailResponse ? extractBompNodes(dr, ['incident']) : [];
        for (const detail of detailIncidents.map(it => mapIncident(provider, it))) {
          claim = claim ? mergeClaimDetails(claim, detail) : detail;
        }
        orderId = scalarFirst(orderId, claim?.orderId, claim?._ctx?.orderId);
      }

      if (!orderId) {
        if (claim) return claim;
        throw Object.assign(new Error('BOMP détail : aucun order_fnac_id disponible pour charger la conversation complète'), {
          statusCode: 400,
          provider: provider.code,
          operation: 'fetchThread'
        });
      }

      async function collectThreadMessages(elements = {}, labelPrefix = 'messages_query/thread') {
        const nodes = [];
        for (let page = 1; page <= threadMaxPages; page++) {
          const response = await safeQuery(
            'messages_query',
            bompQueryXml(provider, token, 'messages_query', { paging: page, ...elements }, threadPageSize),
            page === 1 ? labelPrefix : `${labelPrefix}/page:${page}`
          );
          const root = response?.messages_query_response || response?.messages || response || {};
          const pageNodes = response ? extractBompNodes(root, ['message']) : [];
          nodes.push(...pageNodes);
          if (!pageNodes.length || pageNodes.length < threadPageSize) break;
        }
        return nodes;
      }

      const messageNodes = [];
      messageNodes.push(...await collectThreadMessages(
        { order_fnac_id: orderId },
        `messages_query/order_fnac_id:${orderId}/detail-full`
      ));

      if (useThreadFromTypes) {
        const fromTypes = bompMessageFromTypesFromEnv('BOMP_THREAD_FROM_TYPES', 'CLIENT,CALLCENTER,SELLER,SYSTEM');
        for (const fromType of fromTypes) {
          messageNodes.push(...await collectThreadMessages(
            { order_fnac_id: orderId, message_from_types: [fromType] },
            `messages_query/order_fnac_id:${orderId}/detail-from:${fromType}`
          ));
          if (!useThreadFromTypes) break;
        }
      }

      const mappedMessages = uniqueBompNodes(messageNodes)
        .map(m => mapMessage(provider, m, orderId))
        .filter(c => c._ctx.messageId || c.orderId || c.messages.length);

      const commentsResponse = await safeQuery(
        'client_order_comments_query',
        bompQueryXml(provider, token, 'client_order_comments_query', { order_fnac_id: orderId }, 100),
        `client_order_comments_query/detail-order_fnac_id:${orderId}`
      );
      const cr = commentsResponse?.client_order_comments_query_response || commentsResponse?.client_order_comments || commentsResponse || {};
      const mappedComments = commentsResponse
        ? extractBompNodes(cr, ['client_order_comment', 'comment'])
          .map(c => mapClientOrderComment(provider, c, orderId))
          .filter(c => c.orderId || c.messages.length)
        : [];

      const orderResponse = await safeQuery(
        'orders_query',
        bompQueryXml(provider, token, 'orders_query', { paging: 1, order_fnac_id: orderId }, 20),
        `orders_query/detail-order_fnac_id:${orderId}`
      );
      const or = orderResponse?.orders_query_response || orderResponse?.orders || orderResponse || {};
      const orderInfos = orderResponse ? extractBompNodes(or, ['order']).map(mapOrderInfo).filter(Boolean) : [];
      const orderInfoById = new Map(orderInfos.map(info => [info.orderId, info]));

      const messageThread = mergeClaimsByIncidentOrOrder([...mappedMessages, ...mappedComments])
        .find(c => c.orderId === orderId) || null;

      if (!claim) {
        claim = messageThread || makeClaim(provider.code, {
          providerType: 'bomp',
          id: scalarFirst(incidentId, orderId),
          orderId,
          status: 'nouveau',
          messages: [],
          ctx: { kind: 'message', orderId }
        });
      } else if (messageThread) {
        mergeClaimDetails(claim, messageThread);
      }

      claim.orderId = claim.orderId || orderId;
      enrichClaimFromOrderInfo(claim, orderInfoById);
      claim.messages = dedupeMessages(claim.messages || []);
      claim.updatedAt = Math.max(Number(claim.updatedAt || 0), ...claim.messages.map(m => Number(m.at || 0))) || claim.updatedAt || Date.now();
      claim.dueAt = computeDueAt(claim.messages || []);
      claim._ctx = {
        ...(claim._ctx || {}),
        orderId,
        incidentId: incidentId || claim._ctx?.incidentId,
        messageId: claim._ctx?.messageId || messageThread?._ctx?.messageId,
      };

      if (String(process.env.BOMP_DEBUG || '') === '1') {
        console.log(`[bomp/${provider.code}] détail thread order=${orderId}, messages=${claim.messages.length}, orderInfo=${orderInfos.length}, errors=${errors.length}`);
      }

      return claim;
    },

    async fetchClaims(provider, options = {}) {
      const token = await getToken(provider);
      const claims = [];
      const errors = [];

      // Mode par défaut pour le tableau : ne garder que ce qui attend une réponse.
      // Cela évite de ramener tout l'historique BOMP/Fnac-Darty.
      const onlyWaitingReply = parseBoolFlag(
        process.env.BOMP_ONLY_WAITING_REPLY,
        options.onlyUnanswered !== false
      );
      const enrichLimit = positiveInt(
        process.env.BOMP_ENRICH_LIMIT,
        onlyWaitingReply ? 40 : 50,
        0,
        500
      );

      let useMessageFromTypes = parseBoolFlag(process.env.BOMP_USE_MESSAGE_FROM_TYPES, true);
      const broadQuery = parseBoolFlag(process.env.BOMP_BROAD_QUERY, true);
      const includeGlobalMessages = parseBoolFlag(
        process.env.BOMP_INCLUDE_GLOBAL_MESSAGES,
        !onlyWaitingReply
      );
      const includeCommentsInThreads = parseBoolFlag(
        process.env.BOMP_INCLUDE_ORDER_COMMENTS_IN_THREADS,
        false
      );
      const fallbackGeneralIncidents = parseBoolFlag(
        process.env.BOMP_WAITING_FALLBACK_GENERAL,
        false
      );
      const messagePageSize = positiveInt(process.env.BOMP_MESSAGES_PAGE_SIZE, onlyWaitingReply ? 50 : 100, 1, 500);
      const messageMaxPages = positiveInt(process.env.BOMP_MESSAGES_MAX_PAGES, onlyWaitingReply ? 1 : (broadQuery ? 3 : 1), 1, 50);
      const orderMessageMaxPages = positiveInt(process.env.BOMP_ORDER_MESSAGES_MAX_PAGES, onlyWaitingReply ? 10 : (broadQuery ? 3 : 1), 1, 50);
      const incidentPageSize = positiveInt(process.env.BOMP_INCIDENTS_PAGE_SIZE, 100, 1, 500);
      const incidentMaxPages = positiveInt(process.env.BOMP_INCIDENTS_MAX_PAGES, onlyWaitingReply ? 10 : 5, 1, 50);

      async function safeQuery(operation, xml, label = operation) {
        try {
          return await postXml(provider, operation, xml);
        } catch (e) {
          errors.push({ operation: label, message: e.message, statusCode: e.statusCode });
          // Si l'environnement BOMP ne supporte pas notre forme imbriquée message_from_types,
          // on désactive seulement ce filtre. Les requêtes simples continuent de récupérer CLIENT + CALLCENTER.
          if (/message_from_types|message_from_type|from_type/i.test(String(e.message || ''))) useMessageFromTypes = false;
          console.warn(`[bomp/${provider.code}] ${label} ignoré : ${e.message}`);
          return null;
        }
      }

      async function collectBompMessages(elements = {}, labelPrefix = 'messages_query', maxPages = messageMaxPages) {
        const nodes = [];
        for (let page = 1; page <= maxPages; page++) {
          const response = await safeQuery(
            'messages_query',
            bompQueryXml(provider, token, 'messages_query', { paging: page, ...elements }, messagePageSize),
            page === 1 ? labelPrefix : `${labelPrefix}/page:${page}`
          );
          const root = response?.messages_query_response || response?.messages || response || {};
          const pageNodes = response ? extractBompNodes(root, ['message']) : [];
          nodes.push(...pageNodes);
          if (!pageNodes.length || pageNodes.length < messagePageSize) break;
        }
        return nodes;
      }

      async function collectBompIncidents(elements = {}, labelPrefix = 'incidents_query') {
        const nodes = [];
        for (let page = 1; page <= incidentMaxPages; page++) {
          const response = await safeQuery(
            'incidents_query',
            bompQueryXml(provider, token, 'incidents_query', { paging: page, ...elements }, incidentPageSize),
            page === 1 ? labelPrefix : `${labelPrefix}/page:${page}`
          );
          const root = response?.incidents_query_response || response?.incidents || response || {};
          const pageNodes = response ? extractBompNodes(root, ['incident']) : [];
          nodes.push(...pageNodes);
          if (!pageNodes.length || pageNodes.length < incidentPageSize) break;
        }
        return nodes;
      }

      function bompCsvEnv(name, fallback) {
        return String(process.env[name] || fallback || '')
          .split(',')
          .map(v => v.trim().toUpperCase())
          .filter(Boolean);
      }

      function isBompThreadCandidate(claim) {
        if (!claim) return false;
        const ctx = claim._ctx || {};
        if (ctx.waitingForSeller === true || ctx.needsReply === true) return true;
        return claimNeedsReply(claim);
      }

      async function collectBompMessagesByOrder(orderId) {
        const nodes = [];

        // Important : on charge l'historique complet UNIQUEMENT pour les commandes déjà
        // identifiées comme à traiter. Cela évite de scanner tout l'ancien historique,
        // tout en récupérant les messages CLIENT + CALLCENTER + vos messages SELLER.
        nodes.push(...await collectBompMessages(
          { order_fnac_id: orderId },
          `messages_query/order_fnac_id:${orderId}/thread-full`,
          orderMessageMaxPages
        ));

        // Requêtes complémentaires ciblées par auteur. Fnac/Darty renvoie parfois
        // des fils différents selon le filtre. On inclut aussi les types vendeur pour
        // afficher les messages envoyés par la boutique / vous.
        if (useMessageFromTypes) {
          const fromTypes = [
            ...bompMessageFromTypesFromEnv('BOMP_CLIENT_FROM_TYPES', 'CLIENT,CALLCENTER'),
            ...bompMessageFromTypesFromEnv('BOMP_SELLER_FROM_TYPES', 'SELLER,SYSTEM')
          ];
          for (const fromType of [...new Set(fromTypes)]) {
            nodes.push(...await collectBompMessages(
              { order_fnac_id: orderId, message_from_types: [fromType] },
              `messages_query/order_fnac_id:${orderId}/from:${fromType}`,
              orderMessageMaxPages
            ));
          }
        }

        return uniqueBompNodes(nodes);
      }

      // 1) Requêtes ciblées : en mode standard, on demande d'abord les dossiers
      // explicitement en attente d'une réponse vendeur. On évite ainsi de charger
      // tout l'historique Fnac/Darty.
      const incidentQueries = onlyWaitingReply
        ? [{ waiting_for_seller_answer: true }]
        : [{ }];

      let incidents = [];
      for (const query of incidentQueries) {
        incidents.push(...await collectBompIncidents(
          query,
          query.waiting_for_seller_answer ? 'incidents_query/waiting_for_seller_answer:TRUE' : 'incidents_query'
        ));
      }

      // Fallback désactivé par défaut : utile seulement si ton accès BOMP refuse le filtre
      // waiting_for_seller_answer. Sinon, cela ramènerait de nouveau l'historique ancien.
      if (onlyWaitingReply && !incidents.length && fallbackGeneralIncidents) {
        incidents.push(...await collectBompIncidents({}, 'incidents_query/fallback-general'));
      }

      incidents = uniqueBompNodes(incidents);
      let mappedIncidents = incidents.map(it => mapIncident(provider, it));

      const messageNodes = [];
      if (includeGlobalMessages) {
        messageNodes.push(...await collectBompMessages({}, 'messages_query'));
        if (useMessageFromTypes) {
          messageNodes.push(...await collectBompMessages({ message_archived: false, message_from_types: ['CLIENT'] }, 'messages_query/from:CLIENT'));
        }
        if (useMessageFromTypes) {
          messageNodes.push(...await collectBompMessages({ message_archived: false, message_from_types: ['CALLCENTER'] }, 'messages_query/from:CALLCENTER'));
        }
      } else {
        // Petite requête de secours : messages non archivés et non lus uniquement.
        // Elle ne doit pas remplacer le filtre incident ; elle sert juste à attraper
        // les cas BOMP qui ne passent pas par incidents_query.
        messageNodes.push(...await collectBompMessages({ message_archived: false, message_state: 'UNREAD' }, 'messages_query/unread-not-archived', 1));
      }
      const messages = uniqueBompNodes(messageNodes);
      let mappedMessages = messages
        .map(m => mapMessage(provider, m))
        .filter(c => c._ctx.messageId || c.orderId || c.messages.length);

      let comments = [];
      let mappedComments = [];
      if (includeCommentsInThreads || !onlyWaitingReply) {
        const commentsResponse = await safeQuery(
          'client_order_comments_query',
          bompQueryXml(provider, token, 'client_order_comments_query', { paging: 1 }, 100)
        );
        const cr = commentsResponse?.client_order_comments_query_response || commentsResponse?.client_order_comments || commentsResponse || {};
        comments = commentsResponse ? extractBompNodes(cr, ['client_order_comment', 'comment']) : [];
        mappedComments = comments
          .map(c => mapClientOrderComment(provider, c))
          .filter(c => c.orderId || c.messages.length);
      }

      // 2) Certains retours incidents BOMP sont des résumés : on redemande le détail par incident_id.
      // Ça récupère souvent le order_id/order_fnac_id qui n'était pas dans la liste principale.
      const incidentIdsToExpand = [...new Set(mappedIncidents
        .filter(c => !c.orderId && c._ctx?.incidentId)
        .map(c => c._ctx.incidentId))]
        .slice(0, enrichLimit);

      for (const incidentId of incidentIdsToExpand) {
        const detailResponse = await safeQuery(
          'incidents_query',
          bompQueryXml(provider, token, 'incidents_query', { paging: 1, incident_id: incidentId }, 20),
          `incidents_query/incident_id:${incidentId}`
        );
        const dr = detailResponse?.incidents_query_response || detailResponse?.incidents || detailResponse || {};
        const detailIncidents = detailResponse ? extractBompNodes(dr, ['incident']) : [];
        const detailMapped = detailIncidents.map(it => mapIncident(provider, it));
        for (const detail of detailMapped) {
          const base = mappedIncidents.find(c => c._ctx?.incidentId === detail._ctx?.incidentId || c.id === detail.id);
          if (base) mergeClaimDetails(base, detail);
          else mappedIncidents.push(detail);
        }
      }
      mappedIncidents = mergeClaimsByIncidentOrOrder(mappedIncidents);

      // 3) Deuxième passe par numéro de commande.
      // D'après l'API Fnac, messages_query et client_order_comments_query acceptent order_fnac_id.
      // Sans cette passe, les incidents peuvent s'afficher sans conversation.
      const unreadFallbackMaxAgeDays = positiveInt(process.env.BOMP_UNREAD_FALLBACK_MAX_AGE_DAYS, 14, 0, 365);
      const isRecentUnreadFallback = (c) => {
        if (!unreadFallbackMaxAgeDays) return true;
        const t = claimActivityTime(c);
        return !t || t >= Date.now() - unreadFallbackMaxAgeDays * 24 * H;
      };

      const threadCandidates = onlyWaitingReply
        ? [
            ...mappedIncidents.filter(isBompThreadCandidate),
            ...mappedMessages.filter(c => isBompThreadCandidate(c) && isRecentUnreadFallback(c)),
            ...mappedComments.filter(c => isBompThreadCandidate(c) && isRecentUnreadFallback(c)),
          ]
        : [...mappedIncidents, ...mappedMessages, ...mappedComments];

      const orderIds = [...new Set(threadCandidates.map(c => c.orderId).filter(Boolean))].slice(0, enrichLimit);
      const activeOrderIds = new Set(orderIds);

      const perOrderMessages = [];
      const perOrderComments = [];
      const orderInfos = [];

      for (const orderId of orderIds) {
        const msgByOrder = await collectBompMessagesByOrder(orderId);
        perOrderMessages.push(...msgByOrder.map(m => mapMessage(provider, m, orderId)).filter(c => c._ctx.messageId || c.orderId || c.messages.length));

        if (includeCommentsInThreads || !onlyWaitingReply) {
          const comByOrderResponse = await safeQuery(
            'client_order_comments_query',
            bompQueryXml(provider, token, 'client_order_comments_query', { order_fnac_id: orderId }, 100),
            `client_order_comments_query/order_fnac_id:${orderId}`
          );
          const cor = comByOrderResponse?.client_order_comments_query_response || comByOrderResponse?.client_order_comments || comByOrderResponse || {};
          const comByOrder = comByOrderResponse ? extractBompNodes(cor, ['client_order_comment', 'comment']) : [];
          perOrderComments.push(...comByOrder.map(c => mapClientOrderComment(provider, c, orderId)).filter(c => c.orderId || c.messages.length));
        }

        // Optionnel mais utile : enrichit client / produit depuis la commande.
        const orderResponse = await safeQuery(
          'orders_query',
          bompQueryXml(provider, token, 'orders_query', { paging: 1, order_fnac_id: orderId }, 20),
          `orders_query/order_fnac_id:${orderId}`
        );
        const or = orderResponse?.orders_query_response || orderResponse?.orders || orderResponse || {};
        const orders = orderResponse ? extractBompNodes(or, ['order']) : [];
        orderInfos.push(...orders.map(mapOrderInfo).filter(Boolean));
      }

      mappedMessages = mergeClaimsByIncidentOrOrder([...mappedMessages, ...perOrderMessages]);
      mappedComments = mergeClaimsByIncidentOrOrder([...mappedComments, ...perOrderComments]);
      const orderInfoById = new Map(orderInfos.map(info => [info.orderId, info]));

      mappedIncidents.forEach(c => enrichClaimFromOrderInfo(c, orderInfoById));
      mappedMessages.forEach(c => enrichClaimFromOrderInfo(c, orderInfoById));
      mappedComments.forEach(c => enrichClaimFromOrderInfo(c, orderInfoById));

      // Les incidents Fnac/Darty sont souvent séparés de la messagerie.
      // On rattache les messages/commentaires par order_fnac_id puis on conserve aussi les messages orphelins.
      let messageLikeClaims = mergeClaimsByIncidentOrOrder([...mappedMessages, ...mappedComments]);
      if (onlyWaitingReply) {
        // On ne garde pas les vieux fils orphelins : seules les commandes candidates
        // à traiter peuvent compléter l'affichage. Les messages boutique restent
        // bien présents, mais uniquement dans ces conversations actives.
        messageLikeClaims = messageLikeClaims.filter(m => {
          if (m.orderId && activeOrderIds.has(m.orderId)) return true;
          return isBompThreadCandidate(m) && isRecentUnreadFallback(m);
        });
      }
      const mergedIncidents = mergeBompMessagesIntoIncidents(mappedIncidents, messageLikeClaims);
      claims.push(...mergedIncidents);
      claims.push(...messageLikeClaims.filter(m => !mergedIncidents.some(i => i.orderId && i.orderId === m.orderId)));

      if (String(process.env.BOMP_DEBUG || '') === '1') {
        const allMapped = [...mappedIncidents, ...mappedMessages, ...mappedComments];
        const finalMerged = mergeClaimsByIncidentOrOrder(claims);
        const emptyCount = allMapped.filter(c => !c.orderId && !c.product && !c.messages?.length).length;
        console.log(`[bomp/${provider.code}] raw incidents=${incidents.length}, messages=${messages.length}, comments=${comments.length}, ordersEnriched=${orderInfos.length}, mapped=${allMapped.length}, finalMerged=${finalMerged.length}, emptyLike=${emptyCount}`);
        const sample = finalMerged.slice(0, 8).map(c => ({
          id: c.id, orderId: c.orderId, subject: c.subject, messages: c.messages?.length || 0,
          firstMessage: c.messages?.[0]?.text ? c.messages[0].text.slice(0, 90) : '',
          authors: (c.messages || []).reduce((acc, m) => { acc[m.from || 'unknown'] = (acc[m.from || 'unknown'] || 0) + 1; return acc; }, {}),
          lastFrom: (c.messages || []).slice(-1)[0]?.from || '',
          ctx: { kind: c._ctx?.kind, incidentId: c._ctx?.incidentId, messageId: c._ctx?.messageId, orderId: c._ctx?.orderId }
        }));
        console.log(`[bomp/${provider.code}] final sample`, JSON.stringify(sample, null, 2));
      }

      if (!claims.length && errors.length) {
        const details = errors.map(e => `${e.operation}: ${e.statusCode || '?'} ${e.message}`).join(' | ');
        throw Object.assign(new Error(`BOMP ${provider.code}: aucune donnée récupérée. ${details}`), {
          statusCode: errors.find(e => e.statusCode)?.statusCode || 502,
          provider: provider.code,
          operation: 'fetchClaims'
        });
      }

      let finalClaims = mergeClaimsByIncidentOrOrder(claims);
      if (onlyWaitingReply) {
        finalClaims = finalClaims.filter(c => claimNeedsReply(c));
      }
      return finalClaims;
    },

    async sendReply(provider, ctx, body) {
      const token = await getToken(provider);
      const messageId = scalarFirst(ctx?.messageId, ctx?.id);
      const orderId = scalarFirst(ctx?.orderId, ctx?.order_fnac_id, ctx?.order);
      const commentId = scalarFirst(ctx?.commentId, ctx?.clientOrderCommentId, ctx?.client_order_comment_id);
      const safeBody = String(body || '').trim().replace(/]]>/g, ']]]]><![CDATA[>');
      if (!safeBody) throw Object.assign(new Error('Message vide'), { statusCode: 400, provider: provider.code, operation: 'sendReply' });

      const debugSend = String(process.env.BOMP_SEND_DEBUG || process.env.BOMP_DEBUG || '') === '1';
      const errors = [];
      const subject = firstReadableSubject(ctx?.messageSubject, ctx?.subject) || 'order_information';
      const rawType = cleanText(ctx?.rawType || ctx?.type || '').toUpperCase();
      const messageType = rawType === 'OFFER' ? 'OFFER' : 'ORDER';

      const attempt = async (mode, operation, inner) => {
        try {
          const xml = authedRequest(provider, token, operation, inner);
          if (debugSend) {
            console.log(`[bomp/${provider.code}] send attempt=${mode} operation=${operation} messageId=${messageId || '-'} orderId=${orderId || '-'} commentId=${commentId || '-'}`);
            console.log(maskBompSecrets(xml));
          }
          await postXml(provider, operation, xml);
          return { ok: true, mode };
        } catch (e) {
          errors.push({ mode, operation, status: e.statusCode || e.status || 0, message: e.message });
          if (debugSend) console.warn(`[bomp/${provider.code}] send failed ${mode}: ${e.message}`);
          return { ok: false, error: e };
        }
      };

      // Chemin officiel fnapy : update_messages(Message(action='reply', id=..., to='ALL')).
      // Avant on forçait to=CLIENT : certains comptes Fnac/Darty le refusent en 400.
      // On tente donc ALL d'abord, puis CLIENT en compatibilité.
      if (messageId) {
        const all = await attempt('messages_update:reply:ALL', 'messages_update',
          `  <message action="reply" id="${xmlEscape(messageId)}" to="ALL">
    <description><![CDATA[${safeBody}]]></description>
    <subject>${xmlEscape(subject)}</subject>
    <type>${xmlEscape(messageType)}</type>
  </message>`);
        if (all.ok) return { mode: all.mode };

        const client = await attempt('messages_update:reply:CLIENT', 'messages_update',
          `  <message action="reply" id="${xmlEscape(messageId)}" to="CLIENT">
    <description><![CDATA[${safeBody}]]></description>
    <subject>${xmlEscape(subject)}</subject>
    <type>${xmlEscape(messageType)}</type>
  </message>`);
        if (client.ok) return { mode: client.mode };

        // Variante ultra stricte : sans destinataire explicite. Certains schémas historiques
        // acceptent l'action reply mais refusent l'attribut to selon le canal du message.
        const noTo = await attempt('messages_update:reply:no-to', 'messages_update',
          `  <message action="reply" id="${xmlEscape(messageId)}">
    <description><![CDATA[${safeBody}]]></description>
    <subject>${xmlEscape(subject)}</subject>
    <type>${xmlEscape(messageType)}</type>
  </message>`);
        if (noTo.ok) return { mode: noTo.mode };
      }

      // Secours officiel BOMP/fnapy : réponse à un commentaire client via l'id de commande FNAC/Darty.
      // Même si messages_update a échoué, on tente ce chemin quand un n° commande existe.
      if (orderId) {
        const byOrder = await attempt('client_order_comments_update:order', 'client_order_comments_update',
          `  <comment id="${xmlEscape(orderId)}">
    <comment_reply><![CDATA[${safeBody}]]></comment_reply>
  </comment>`);
        if (byOrder.ok) return { mode: byOrder.mode };
      }

      // Dernier secours : certains retours exposent un vrai client_order_comment_id.
      if (commentId && commentId !== orderId) {
        const byComment = await attempt('client_order_comments_update:comment', 'client_order_comments_update',
          `  <comment id="${xmlEscape(commentId)}">
    <comment_reply><![CDATA[${safeBody}]]></comment_reply>
  </comment>`);
        if (byComment.ok) return { mode: byComment.mode };
      }

      const summary = errors.map(e => `${e.mode}: ${e.message}`).join(' | ');
      throw Object.assign(new Error(summary || 'Réponse BOMP impossible : aucun message_id ni order_id exploitable'), {
        statusCode: errors.find(e => e.status >= 400 && e.status < 500)?.status || 400,
        provider: provider.code,
        operation: 'sendReply',
        attempts: errors,
      });
    },
  };
})();

const ADAPTERS = { octopia, mirakl, bomp };

/* =====================================================================
   5bis) SUIVI DE LIVRAISON — API directe par transporteur
   ---------------------------------------------------------------------
   ⚠ NE PAS scraper les sites transporteurs (fragile, souvent bloqué, CGU).
   Transporteurs préparés : Colissimo/La Poste, Chronopost, DPD, GLS, UPS,
   DHL, FedEx/TNT. Chaque adaptateur renvoie le format normalisé :
     { status:"en_transit|livre|pret_retrait|en_attente|incident",
       etaH:<heures avant livraison|null>, events:[{at:<ISO|ms>, label:"..."}] }
   Statut : mapStatus(label) déduit l'état à partir du libellé/code de l'événement.
   Identifiants via variables d'environnement (voir GUIDE).
   ⚠ Les chemins de parsing marqués TODO sont à ajuster sur une vraie réponse.
   =====================================================================*/

// Déduction d'un statut normalisé à partir d'un texte d'événement
function mapStatus(text) {
  const t = (text || '').toLowerCase();
  if (/livr|delivered|remis/.test(t)) return 'livre';
  if (/point relais|relais|pickup|disposal|à retirer|consigne/.test(t)) return 'pret_retrait';
  if (/incident|échec|echec|absent|retour|refus|exception|problème|anomalie|perdu/.test(t)) return 'incident';
  if (/préparation|preparation|étiquette|label|enregistr|created|annonce|attente|pending/.test(t)) return 'en_attente';
  if (/expédi|expedie|shipped|pris en charge|accepted|collected|achemin|transit|hub|tri|route|en cours de livraison|out for delivery|en livraison|départ|depart|arriv/.test(t)) return 'en_transit';
  return 'inconnu';
}

// Cache de token OAuth (UPS, FedEx)
const oauthCache = {};
async function getOAuthToken(key, tokenUrl, body, headers) {
  const c = oauthCache[key];
  if (c && Date.now() < c.exp) return c.value;
  const r = await fetch(tokenUrl, { method: 'POST', headers, body });
  if (!r.ok) throw new Error(`${key} auth ${r.status}`);
  const j = await r.json();
  oauthCache[key] = { value: j.access_token, exp: Date.now() + ((j.expires_in || 3600) - 120) * 1000 };
  return oauthCache[key].value;
}

const CARRIERS = {
  // ---- Colissimo / La Poste — API "Suivi v2" (clé Okapi) ----
  colissimo: {
    async track(number) {
      if (!process.env.LAPOSTE_OKAPI_KEY) throw new Error('Colissimo: clé Okapi manquante (LAPOSTE_OKAPI_KEY)');
      const r = await fetch(`https://api.laposte.fr/suivi/v2/idships/${encodeURIComponent(number)}`,
        { headers: { 'X-Okapi-Key': process.env.LAPOSTE_OKAPI_KEY, Accept: 'application/json' } });
      if (!r.ok) throw new Error(`Colissimo ${r.status}`);
      const sh = (await r.json()).shipment || {};
      const events = (sh.event || []).map(e => ({ at: e.date, label: e.label }));
      return { status: events[0] ? mapStatus(events[0].label) : 'inconnu', etaH: null, events };
    },
  },

  // ---- Chronopost — WS de suivi (compte + mot de passe) ----
  chronopost: {
    async track(number) {
      if (!process.env.CHRONOPOST_ACCOUNT || !process.env.CHRONOPOST_PASSWORD) throw new Error('Chronopost: identifiants manquants (CHRONOPOST_ACCOUNT/PASSWORD)');
      // REST de suivi Chronopost (sinon WS SOAP TrackingServiceWS). TODO: ajuster selon votre contrat.
      const u = `https://www.chronopost.fr/tracking-cxf/TrackingServiceWS/track?accountNumber=${process.env.CHRONOPOST_ACCOUNT}&password=${process.env.CHRONOPOST_PASSWORD}&skybillNumber=${encodeURIComponent(number)}&language=fr_FR`;
      const r = await fetch(u, { headers: { Accept: 'application/json' } });
      if (!r.ok) throw new Error(`Chronopost ${r.status}`);
      const j = await r.json();
      const evs = (j.listEventInfoComp || j.events || []).map(e => ({ at: e.eventDate || e.date, label: e.eventLabel || e.label })); // TODO
      return { status: evs[0] ? mapStatus(evs[0].label) : 'inconnu', etaH: null, events: evs };
    },
  },

  // ---- DPD France — WS de suivi (identifiants) ----
  dpd: {
    async track(number) {
      if (!process.env.DPD_USER || !process.env.DPD_KEY) throw new Error('DPD: identifiants manquants (DPD_USER/DPD_KEY)');
      // TODO: endpoint DPD France (ex-API e-station). Ajuster URL/auth selon votre contrat.
      const r = await fetch(`https://api.dpd.fr/tracking/v1/parcels/${encodeURIComponent(number)}`,
        { headers: { Authorization: `Bearer ${process.env.DPD_KEY}`, Accept: 'application/json' } });
      if (!r.ok) throw new Error(`DPD ${r.status}`);
      const j = await r.json();
      const evs = (j.scanInfo || j.events || []).map(e => ({ at: e.date, label: e.status || e.label })); // TODO
      return { status: evs[0] ? mapStatus(evs[0].label) : 'inconnu', etaH: null, events: evs };
    },
  },

  // ---- GLS — Track & Trace REST (identifiants) ----
  gls: {
    async track(number) {
      if (!process.env.GLS_USER || !process.env.GLS_PASSWORD) throw new Error('GLS: identifiants manquants (GLS_USER/GLS_PASSWORD)');
      const auth = Buffer.from(`${process.env.GLS_USER}:${process.env.GLS_PASSWORD}`).toString('base64');
      const r = await fetch(`https://api.gls-group.eu/public/v1/tracking/references/${encodeURIComponent(number)}`,
        { headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' } });
      if (!r.ok) throw new Error(`GLS ${r.status}`);
      const j = await r.json();
      const p = (j.parcels && j.parcels[0]) || {};
      const evs = (p.events || []).map(e => ({ at: e.timestamp, label: e.description })); // TODO
      return { status: evs[0] ? mapStatus(evs[0].label) : 'inconnu', etaH: null, events: evs };
    },
  },

  // ---- UPS — Tracking API (OAuth client_credentials) ----
  ups: {
    async track(number) {
      if (!process.env.UPS_CLIENT_ID || !process.env.UPS_CLIENT_SECRET) throw new Error('UPS: identifiants manquants (UPS_CLIENT_ID/SECRET)');
      const basic = Buffer.from(`${process.env.UPS_CLIENT_ID}:${process.env.UPS_CLIENT_SECRET}`).toString('base64');
      const token = await getOAuthToken('ups', 'https://onlinetools.ups.com/security/v1/oauth/token',
        'grant_type=client_credentials', { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' });
      const r = await fetch(`https://onlinetools.ups.com/api/track/v1/details/${encodeURIComponent(number)}`,
        { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
      if (!r.ok) throw new Error(`UPS ${r.status}`);
      const j = await r.json();
      const pkg = j.trackResponse?.shipment?.[0]?.package?.[0] || {};
      const evs = (pkg.activity || []).map(a => ({ at: `${a.date} ${a.time}`, label: a.status?.description })); // TODO
      return { status: evs[0] ? mapStatus(evs[0].label) : 'inconnu', etaH: null, events: evs };
    },
  },

  // ---- DHL — Shipment Tracking Unified API (clé API) ----
  dhl: {
    async track(number) {
      if (!process.env.DHL_API_KEY) throw new Error('DHL: clé manquante (DHL_API_KEY)');
      const r = await fetch(`https://api-eu.dhl.com/track/shipments?trackingNumber=${encodeURIComponent(number)}`,
        { headers: { 'DHL-API-Key': process.env.DHL_API_KEY, Accept: 'application/json' } });
      if (!r.ok) throw new Error(`DHL ${r.status}`);
      const s = (await r.json()).shipments?.[0] || {};
      const evs = (s.events || []).map(e => ({ at: e.timestamp, label: e.description || e.status }));
      return {
        status: s.status?.statusCode === 'delivered' ? 'livre' : (evs[0] ? mapStatus(evs[0].label) : 'inconnu'),
        etaH: null, events: evs
      };
    },
  },

  // ---- FedEx (et TNT, réseau FedEx) — Track API (OAuth) ----
  fedex: {
    async track(number) {
      if (!process.env.FEDEX_CLIENT_ID || !process.env.FEDEX_CLIENT_SECRET) throw new Error('FedEx: identifiants manquants (FEDEX_CLIENT_ID/SECRET)');
      const token = await getOAuthToken('fedex', 'https://apis.fedex.com/oauth/token',
        `grant_type=client_credentials&client_id=${process.env.FEDEX_CLIENT_ID}&client_secret=${process.env.FEDEX_CLIENT_SECRET}`,
        { 'Content-Type': 'application/x-www-form-urlencoded' });
      const r = await fetch('https://apis.fedex.com/track/v1/trackingnumbers', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ trackingInfo: [{ trackingNumberInfo: { trackingNumber: number } }], includeDetailedScans: true })
      });
      if (!r.ok) throw new Error(`FedEx ${r.status}`);
      const j = await r.json();
      const tr = j.output?.completeTrackResults?.[0]?.trackResults?.[0] || {};
      const evs = (tr.scanEvents || []).map(e => ({ at: e.date, label: e.eventDescription }));
      return { status: evs[0] ? mapStatus(evs[0].label) : 'inconnu', etaH: null, events: evs };
    },
  },
  tnt: { async track(n) { return CARRIERS.fedex.track(n); } },  // TNT suivi via le réseau FedEx

  // ---- ChezVous (livraison à domicile) — API à brancher ----
  chezvous: {
    async track(number) {
      if (!process.env.CHEZVOUS_KEY) throw new Error('ChezVous: clé manquante (CHEZVOUS_KEY)');
      // TODO: endpoint/auth ChezVous à confirmer auprès du transporteur.
      const r = await fetch(`https://api.chezvous.fr/tracking/${encodeURIComponent(number)}`,
        { headers: { Authorization: `Bearer ${process.env.CHEZVOUS_KEY}`, Accept: 'application/json' } });
      if (!r.ok) throw new Error(`ChezVous ${r.status}`);
      const j = await r.json();
      const evs = (j.events || []).map(e => ({ at: e.date, label: e.label || e.status })); // TODO
      return { status: evs[0] ? mapStatus(evs[0].label) : 'inconnu', etaH: null, events: evs };
    },
  },
};

/* =====================================================================
   6) ROUTES EXPOSÉES À LA PAGE
   =====================================================================*/
function isConfigured(p) {
  if (p.type === 'octopia') return p.auth.clientId && p.auth.clientSecret && p.auth.sellerId;
  if (p.type === 'bomp') return p.partnerId && p.shopId && p.key;
  return p.url && p.key;
}
function missingConfig(p) {
  if (p.type === 'octopia') {
    return [
      ['OCTOPIA_CLIENT_ID', p.auth.clientId],
      ['OCTOPIA_CLIENT_SECRET', p.auth.clientSecret],
      ['OCTOPIA_SELLER_ID', p.auth.sellerId],
    ].filter(([, v]) => !v).map(([k]) => k);
  }
  if (p.type === 'bomp') {
    const prefix = String(p.code || '').toUpperCase();
    return [
      [`${prefix}_PARTNER_ID`, p.partnerId],
      [`${prefix}_SHOP_ID`, p.shopId],
      [`${prefix}_KEY`, p.key],
    ].filter(([, v]) => !v).map(([k]) => k);
  }
  const prefix = String(p.code || '').toUpperCase();
  return [[`${prefix}_URL`, p.url], [`${prefix}_KEY`, p.key]].filter(([, v]) => !v).map(([k]) => k);
}
const configured = () => PROVIDERS.filter(p => ADAPTERS[p.type] && isConfigured(p));


// Une réclamation "à répondre" = ouverte + dernier message utile envoyé par le client.
// On ne se base pas uniquement sur le statut marketplace, car certains statuts restent "open"
// même après une réponse vendeur. Le dernier message est donc la source la plus fiable.
function normalizeMessageTime(m) {
  const t = Number(m?.at) || parseMarketplaceDate(m?.rawAt || m?.date || m?.created_at || m?.createdAt, 0);
  return Number.isFinite(t) ? t : 0;
}
function claimNeedsReply(claim) {
  if (!claim || isClaimClosedByMarketplace(claim)) return false;
  const ctx = claim._ctx || {};
  const isBomp = claim.marketplace && ['fnac', 'darty'].includes(String(claim.marketplace).toLowerCase());
  const messages = Array.isArray(claim.messages) ? claim.messages.filter(m => m && m.from) : [];

  // Pour Fnac/Darty, si l'API dit explicitement waiting_for_seller_answer=TRUE,
  // on lui fait confiance : cela évite de perdre une réclamation à traiter parce que
  // l'historique rattaché contient aussi d'anciens messages boutique.
  if (isBomp && ctx.waitingForSeller === true) return true;

  // Source fiable quand le fil est complet : le dernier message utile.
  // Si la boutique a répondu après le client, on ne doit plus afficher la réclamation.
  if (messages.length) {
    const last = [...messages].sort((a, b) => normalizeMessageTime(a) - normalizeMessageTime(b)).at(-1);
    return last?.from === 'client';
  }

  // Flags explicites renvoyés par la marketplace ou déduits au mapping.
  if (ctx.waitingForSeller === true || ctx.needsReply === true) return true;

  // Cas BOMP : sans fil de messages et sans waiting_for_seller_answer, on ne garde pas.
  if (isBomp && ctx.kind === 'incident' && ctx.incidentId) return false;

  return false;
}

function claimActivityTime(claim) {
  const ctx = claim?._ctx || {};
  const messages = Array.isArray(claim?.messages) ? claim.messages : [];
  const times = [
    Number(claim?.updatedAt || 0),
    Number(ctx.updatedAt || 0),
    Number(ctx.openedAt || 0),
    ...messages.map(normalizeMessageTime),
  ].filter(t => Number.isFinite(t) && t > 0);
  return times.length ? Math.max(...times) : 0;
}

function claimIsRecentEnough(claim, maxAgeDays) {
  const days = Number(maxAgeDays || 0);
  if (!Number.isFinite(days) || days <= 0) return true;
  const t = claimActivityTime(claim);
  if (!t) return true; // en cas de date absente côté API, on garde pour éviter un faux négatif
  return t >= Date.now() - days * 24 * H;
}

function resolveMaxAgeDays(req, onlyUnanswered, provider = null) {
  const explicit = req.query.days || req.query.maxAgeDays;
  const providerDefault = provider?.type === 'bomp' ? process.env.BOMP_MAX_AGE_DAYS : undefined;
  const raw = explicit || providerDefault || process.env.RECLAMATIONS_MAX_AGE_DAYS || (onlyUnanswered ? 45 : 0);
  const days = Number(raw);
  return Number.isFinite(days) ? days : 45;
}
function shouldFetchDetailForReplySignal(provider, claim) {
  if (!provider || !claim) return false;
  const ctx = claim._ctx || {};
  const messages = Array.isArray(claim.messages) ? claim.messages.filter(m => m && m.from) : [];

  // La liste doit rester ciblée : si on a déjà un dernier message ou un flag API fiable,
  // inutile de recharger tout le fil juste pour savoir si la réclamation est à traiter.
  if (messages.length) return false;
  if (ctx.waitingForSeller === true || ctx.needsReply === true) return false;
  if (claim.status === 'resolu') return false;

  // Dernier recours : certains opérateurs renvoient une réclamation sans dernier message.
  // Là seulement on ouvre le détail pour éviter un faux négatif.
  return Boolean(ADAPTERS[provider.type]?.fetchThread && claim._ctx);
}

async function ensureClaimHasMessages(provider, claim, opts = {}) {
  if (!opts.force && claim?.messages?.length) return claim;
  const adapter = ADAPTERS[provider.type];
  if (!adapter?.fetchThread || !claim?._ctx) return claim;
  try {
    return await adapter.fetchThread(provider, claim._ctx);
  } catch (e) {
    console.warn(`[${provider.type}/${provider.code || ''}] détail ignoré pour ${claim?.id || '?'} : ${e.message}`);
    return claim;
  }
}

// Index des claims en mémoire pour retrouver le contexte (_ctx) à la réponse.
const claimIndex = new Map();
const incidentIndex = new Map();

function mapClaimToIncidentRow(claim) {
  const ctx = claim._ctx || {};
  const messages = Array.isArray(claim.messages) ? [...claim.messages].sort((a, b) => normalizeMessageTime(a) - normalizeMessageTime(b)) : [];
  const first = messages[0];
  const last = messages.at(-1);
  const lastBy = last?.from === 'client' ? 'client' : 'boutique';
  const openedAt = new Date(ctx.openedAt || first?.at || claim.updatedAt || Date.now()).toISOString().slice(0, 16);
  const lastAt = new Date(last?.at || claim.updatedAt || Date.now()).toISOString().slice(0, 16);
  return {
    id: claim.id,
    claimId: claim.id,
    remote: true,
    canReply: Boolean(ctx.messageId || ctx.orderId),
    replyMode: ctx.messageId ? 'message' : (ctx.orderId ? 'order_comment' : ''),
    openedAt,
    openedBy: first?.from === 'seller' ? 'boutique' : 'client',
    state: claim.status === 'resolu' ? 'resolu' : 'en_cours',
    motif: inferIncidentMotif(claim.subject, claim.messages),
    orderId: claim.orderId || ctx.orderId || '',
    orderAt: openedAt,
    channel: claim.marketplace,
    product: claim.product || '',
    sku: claim.ean || ctx.orderDetailId || '',
    total: claim.total || null,
    customer: claim.customer || 'Client',
    msgs: messages.length,
    lastBy,
    lastAt,
    conv: messages.map(m => ({
      at: Number(m.at) || Date.now(),
      by: m.from === 'client' ? 'client' : 'boutique',
      text: m.text || '',
    })),
  };
}

function inferIncidentMotif(subject, messages = []) {
  const t = cleanText([subject, ...messages.map(m => m.text || '')].join(' ')).toLowerCase();
  if (/non conforme|mauvais|erreur de r[ée]f|pas celui/.test(t)) return 'non_conforme';
  if (/d[ée]fect|panne|ne fonctionne|sav|garantie/.test(t)) return 'defectueux';
  if (/non re[çc]u|pas re[çc]u|jamais re[çc]u|perdu|livr[ée].*rien/.test(t)) return 'non_recu';
  if (/retard|d[ée]lai|livraison/.test(t)) return 'retard';
  return 'autre';
}

function claimLooksLikeIncidentFallback(claim) {
  // Fallback v19 : si Fnac/Darty ne renvoie aucun vrai nœud incidents_query,
  // on peut tout de même alimenter l'onglet Incidents avec les fils BOMP qui
  // ressemblent à un dossier SAV/litige. On garde cette logique prudente et
  // désactivable avec INCIDENTS_INCLUDE_THREAD_FALLBACK=0.
  if (!claim || isClaimClosedByMarketplace(claim)) return false;
  const messages = Array.isArray(claim.messages) ? claim.messages : [];
  if (!claim.orderId && !messages.length) return false;
  const text = foldStatusText([
    claim.subject,
    claim.marketplaceStatus,
    claim.statusRaw,
    ...(messages || []).map(m => m?.text || '')
  ].join(' '));
  if (/(incident|litige|reclamation|reclamations|sav|garantie|panne|defectueux|defectueuse|casse|cas[se]e|endommage|non recu|pas recu|jamais recu|colis perdu|retard|non conforme|rembours|retour|piece manquante|article manquant)/.test(text)) return true;
  return claimNeedsReply(claim);
}




/* =====================================================================
   CACHE MUTUALISÉ RÉCLAMATIONS / INCIDENTS
   ---------------------------------------------------------------------
   Objectif : plusieurs utilisateurs peuvent charger la plateforme sans
   relancer simultanément tous les appels Mirakl / Octopia / BOMP.
   =====================================================================*/
const threadsCache = new Map();
const threadsInFlight = new Map();
const threadsLastRefreshStart = new Map();
const incidentsCache = new Map();
const incidentsInFlight = new Map();
const incidentsLastRefreshStart = new Map();

function cacheStatePayload(cache, key, extra = {}) {
  return {
    cache,
    key,
    at: Date.now(),
    ...extra,
  };
}

function providerKey(p) {
  return String(p.code || p.label || p.type || '').toLowerCase();
}
function providerPublicInfo(p) {
  return {
    type: p.type,
    code: p.code || p.type,
    label: p.label || p.code || p.type,
  };
}
function providerMatchesFilter(p, rawFilter) {
  const filter = cleanText(rawFilter).toLowerCase();
  if (!filter) return true;
  const wanted = new Set(filter.split(',').map(x => x.trim()).filter(Boolean));
  if (!wanted.size) return true;
  return wanted.has(String(p.type || '').toLowerCase()) ||
    wanted.has(String(p.code || '').toLowerCase()) ||
    wanted.has(String(p.label || '').toLowerCase()) ||
    wanted.has(providerKey(p));
}
function filteredConfiguredProviders(rawFilter, baseProviders = configured()) {
  return baseProviders.filter(p => providerMatchesFilter(p, rawFilter));
}
function stableCacheKey(obj) {
  return JSON.stringify(Object.keys(obj).sort().reduce((acc, k) => {
    acc[k] = obj[k];
    return acc;
  }, {}));
}
function threadsRequestOptions(req) {
  const onlyUnanswered = req.query.all !== '1' && String(req.query.unanswered || '1') !== '0';
  const maxAgeDays = resolveMaxAgeDays(req, onlyUnanswered);
  return {
    onlyUnanswered,
    maxAgeDays,
    providersFilter: cleanText(req.query.providers || req.query.provider || ''),
    concurrency: positiveInt(req.query.concurrency || process.env.PROVIDER_CONCURRENCY, 6, 1, 20),
    providerTimeoutMs: positiveInt(req.query.providerTimeoutMs || process.env.THREADS_PROVIDER_TIMEOUT_MS || process.env.PROVIDER_TIMEOUT_MS, 15000, 0, 120000),
    cacheTtlMs: positiveInt(req.query.cacheTtlMs || process.env.THREADS_CACHE_TTL_MS, 180000, 0, 24 * 60 * 60 * 1000),
    staleWhileRefresh: String(req.query.stale ?? process.env.THREADS_STALE_WHILE_REFRESH ?? '1') !== '0',
    refreshCooldownMs: positiveInt(req.query.refreshCooldownMs || process.env.THREADS_REFRESH_COOLDOWN_MS, 60000, 0, 24 * 60 * 60 * 1000),
    enrichDetails: parseBoolFlag(req.query.enrichDetails ?? process.env.THREADS_ENRICH_DETAILS, false),
  };
}
function threadsCacheKey(options) {
  return stableCacheKey({
    scope: 'threads',
    onlyUnanswered: options.onlyUnanswered ? 1 : 0,
    maxAgeDays: options.maxAgeDays || 0,
    providers: options.providersFilter || '',
    enrichDetails: options.enrichDetails ? 1 : 0,
  });
}

function getThreadsCacheSnapshot(options = {}, allowStale = false) {
  const key = threadsCacheKey(options);
  const cached = threadsCache.get(key);
  if (!cached) return null;

  const now = Date.now();
  const ageMs = Math.max(0, now - Number(cached.at || 0));
  const fresh = options.cacheTtlMs > 0 && ageMs < options.cacheTtlMs;

  if (!fresh && !allowStale) return null;

  restoreThreadsResult(cached);
  return {
    ...cached,
    key,
    cache: fresh ? 'HIT' : 'STALE',
    ageMs,
    fresh,
  };
}

function threadsCacheDiagnostics() {
  const now = Date.now();
  return Array.from(threadsCache.entries()).map(([key, value]) => ({
    key,
    count: Array.isArray(value?.data) ? value.data.length : 0,
    providers: Array.isArray(value?.providers) ? value.providers.length : 0,
    providerChunks: Array.isArray(value?.providerChunks) ? value.providerChunks.length : 0,
    ageMs: Math.max(0, now - Number(value?.at || 0)),
    at: value?.at || null,
  }));
}

function incidentsRequestOptions(req) {
  // Incidents ≠ réclamations à répondre.
  // Avant la v19, l'endpoint incidents était filtré par défaut comme les réclamations
  // (`waiting_for_seller_answer=TRUE`). Sur Fnac/Darty, ce flag n'est pas toujours
  // renseigné sur incidents_query, ce qui donnait 0 incident alors que des dossiers existent.
  const onlyUnanswered = req.query.all !== '1' && /^(1|true|yes|on)$/i.test(String(req.query.unanswered || req.query.onlyUnanswered || '0'));
  const explicitDays = req.query.days || req.query.maxAgeDays;
  const maxAgeDays = positiveInt(
    explicitDays || process.env.INCIDENTS_MAX_AGE_DAYS || process.env.BOMP_INCIDENTS_MAX_AGE_DAYS || (onlyUnanswered ? 45 : 90),
    onlyUnanswered ? 45 : 90,
    0,
    3650
  );
  return {
    onlyUnanswered,
    maxAgeDays,
    providersFilter: cleanText(req.query.providers || req.query.provider || 'fnac,darty'),
    concurrency: positiveInt(req.query.concurrency || process.env.INCIDENTS_PROVIDER_CONCURRENCY || process.env.PROVIDER_CONCURRENCY, 2, 1, 10),
    providerTimeoutMs: positiveInt(req.query.providerTimeoutMs || process.env.INCIDENTS_PROVIDER_TIMEOUT_MS || process.env.PROVIDER_TIMEOUT_MS, 15000, 0, 120000),
    cacheTtlMs: positiveInt(req.query.cacheTtlMs || process.env.INCIDENTS_CACHE_TTL_MS, 180000, 0, 24 * 60 * 60 * 1000),
    staleWhileRefresh: String(req.query.stale ?? process.env.INCIDENTS_STALE_WHILE_REFRESH ?? '1') !== '0',
    refreshCooldownMs: positiveInt(req.query.refreshCooldownMs || process.env.INCIDENTS_REFRESH_COOLDOWN_MS || process.env.THREADS_REFRESH_COOLDOWN_MS, 60000, 0, 24 * 60 * 60 * 1000),
    enrichDetails: parseBoolFlag(req.query.enrichDetails ?? process.env.INCIDENTS_ENRICH_DETAILS, false),
    includeThreadFallback: parseBoolFlag(req.query.includeThreadFallback ?? process.env.INCIDENTS_INCLUDE_THREAD_FALLBACK, true),
  };
}
function incidentsCacheKey(options) {
  return stableCacheKey({
    scope: 'incidents',
    onlyUnanswered: options.onlyUnanswered ? 1 : 0,
    maxAgeDays: options.maxAgeDays || 0,
    providers: options.providersFilter || '',
    enrichDetails: options.enrichDetails ? 1 : 0,
    includeThreadFallback: options.includeThreadFallback ? 1 : 0,
  });
}
function cloneForPublic(claim, provider = null) {
  return decorateClaimAttachmentsForPublic(provider, claim);
}
function restoreClaimIndexFromEntries(entries = [], clear = true) {
  if (clear) claimIndex.clear();
  for (const item of entries) {
    if (!item || !item.id || !item.entry) continue;
    claimIndex.set(item.id, item.entry);
  }
}
function restoreIncidentIndexFromEntries(entries = [], clear = true) {
  if (clear) incidentIndex.clear();
  for (const item of entries) {
    if (!item || !item.id || !item.entry) continue;
    incidentIndex.set(item.id, item.entry);
    claimIndex.set(item.id, item.entry);
  }
}
function restoreThreadsResult(result) {
  restoreClaimIndexFromEntries(result?.claimEntries || [], true);
  if (Array.isArray(result?.incidentEntries) && result.incidentEntries.length) {
    restoreIncidentIndexFromEntries(result.incidentEntries, false);
  }
}
function restoreIncidentsResult(result) {
  restoreIncidentIndexFromEntries(result?.incidentEntries || [], true);
}
async function collectClaimsForCache(options = {}, onProvider = null) {
  const all = [];
  const claimEntries = [];
  const incidentEntries = [];
  const providerChunks = [];
  const providers = filteredConfiguredProviders(options.providersFilter, configured());
  let completed = 0;

  await mapLimit(providers, options.concurrency, async (p, idx) => {
    const info = providerPublicInfo(p);
    try {
      const fetched = await promiseWithTimeout(
        ADAPTERS[p.type].fetchClaims(p, { onlyUnanswered: options.onlyUnanswered, maxAgeDays: options.maxAgeDays }),
        options.providerTimeoutMs,
        `threads ${p.type}/${p.code || 'octopia'}`
      );
      const providerMaxAgeDays = options.maxAgeDays || 0;
      const kept = [];

      for (const rawClaim of (Array.isArray(fetched) ? fetched : [])) {
        const shouldFetchDetail = options.enrichDetails || (options.onlyUnanswered && shouldFetchDetailForReplySignal(p, rawClaim));
        const claim = shouldFetchDetail ? await ensureClaimHasMessages(p, rawClaim, { force: Boolean(options.enrichDetails) }) : rawClaim;
        if (options.onlyUnanswered && !claimNeedsReply(claim)) continue;
        if (!claimIsRecentEnough(claim, providerMaxAgeDays)) continue;

        claim.subject = normalizeSubject(
          claim.subject,
          Array.isArray(claim.messages) ? [...claim.messages].reverse().find(m => m.from === 'client')?.text : ''
        );
        const ctx = claim._ctx || rawClaim._ctx || {};
        const cachedClaim = { ...claim, _ctx: ctx };
        const entry = { provider: p, ctx, claim: cachedClaim };
        claimEntries.push({ id: claim.id, entry });
        if (ctx.kind === 'incident' || ctx.incidentId) {
          incidentEntries.push({ id: claim.id, entry });
        }
        const publicClaim = cloneForPublic(cachedClaim, p);
        kept.push(publicClaim);
        all.push(publicClaim);
      }

      completed += 1;
      const payload = {
        provider: info,
        rows: kept,
        fetched: Array.isArray(fetched) ? fetched.length : 0,
        kept: kept.length,
        completed,
        total: providers.length,
        ok: true,
      };
      providerChunks[idx] = payload;
      if (onProvider) onProvider(payload);
      console.log(`[${p.type}/${p.code || 'octopia'}] ${kept.length}/${Array.isArray(fetched) ? fetched.length : 0} réclamation(s) à répondre, fenêtre=${providerMaxAgeDays || 'illimitée'}j`);
    } catch (e) {
      completed += 1;
      const payload = {
        provider: info,
        rows: [],
        error: e.message,
        completed,
        total: providers.length,
        ok: false,
      };
      providerChunks[idx] = payload;
      if (onProvider) onProvider(payload);
      console.error(`[${p.type}/${p.code || ''}] ${e.message}`);
    }
  });

  all.sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
  return { data: all, claimEntries, incidentEntries, providerChunks: providerChunks.filter(Boolean), providers: providers.map(providerPublicInfo), at: Date.now() };
}
async function getThreadsCached(options = {}, forceRefresh = false, onProvider = null) {
  const key = threadsCacheKey(options);
  const now = Date.now();
  const cached = threadsCache.get(key);
  const fresh = cached && options.cacheTtlMs > 0 && (now - cached.at) < options.cacheTtlMs;

  if (!forceRefresh && fresh) {
    restoreThreadsResult(cached);
    return { ...cached, cache: 'HIT', key };
  }

  if (forceRefresh && cached && options.refreshCooldownMs > 0) {
    const last = threadsLastRefreshStart.get(key) || cached.at || 0;
    if (now - last < options.refreshCooldownMs) {
      restoreThreadsResult(cached);
      return { ...cached, cache: 'COOLDOWN', key };
    }
  }

  if (threadsInFlight.has(key)) {
    if (cached && options.staleWhileRefresh) {
      restoreThreadsResult(cached);
      return { ...cached, cache: 'WAIT-STALE', key };
    }
    const result = await threadsInFlight.get(key);
    restoreThreadsResult(result);
    return { ...result, cache: 'WAIT', key };
  }

  if (!forceRefresh && cached && options.staleWhileRefresh) {
    threadsLastRefreshStart.set(key, now);
    const refresh = collectClaimsForCache(options)
      .then(result => {
        threadsCache.set(key, result);
        restoreThreadsResult(result);
        return result;
      })
      .catch(e => {
        console.error('[threads/cache refresh]', e.message);
        return cached;
      })
      .finally(() => threadsInFlight.delete(key));
    threadsInFlight.set(key, refresh);
    restoreThreadsResult(cached);
    return { ...cached, cache: 'STALE', key };
  }

  threadsLastRefreshStart.set(key, now);
  const task = collectClaimsForCache(options, onProvider)
    .then(result => {
      threadsCache.set(key, result);
      restoreThreadsResult(result);
      return result;
    })
    .finally(() => threadsInFlight.delete(key));
  threadsInFlight.set(key, task);
  const result = await task;
  return { ...result, cache: 'MISS', key };
}
async function collectIncidentsForCache(options = {}) {
  const rows = [];
  const incidentEntries = [];
  const providers = filteredConfiguredProviders(options.providersFilter, configured().filter(p => p.type === 'bomp'));

  await mapLimit(providers, options.concurrency, async (p) => {
    try {
      const fetched = await promiseWithTimeout(
        ADAPTERS[p.type].fetchClaims(p, { onlyUnanswered: options.onlyUnanswered, maxAgeDays: options.maxAgeDays }),
        options.providerTimeoutMs,
        `incidents ${p.type}/${p.code || ''}`
      );
      const providerMaxAgeDays = options.maxAgeDays || 0;

      const nativeRows = [];
      const nativeEntries = [];
      const fallbackRows = [];
      const fallbackEntries = [];
      let nativeSeen = 0;
      let fallbackSeen = 0;

      for (const rawClaim of (Array.isArray(fetched) ? fetched : [])) {
        const shouldFetchDetail = options.enrichDetails || (options.onlyUnanswered && shouldFetchDetailForReplySignal(p, rawClaim));
        const claim = shouldFetchDetail ? await ensureClaimHasMessages(p, rawClaim, { force: Boolean(options.enrichDetails) }) : rawClaim;
        const ctx = claim._ctx || rawClaim._ctx || {};
        const isNativeIncident = ctx.kind === 'incident' || Boolean(ctx.incidentId);
        const isFallbackIncident = !isNativeIncident && options.includeThreadFallback && claimLooksLikeIncidentFallback(claim);
        if (!isNativeIncident && !isFallbackIncident) continue;
        if (options.onlyUnanswered && !claimNeedsReply(claim)) continue;
        if (!claimIsRecentEnough(claim, providerMaxAgeDays)) continue;

        const incidentCtx = isNativeIncident
          ? ctx
          : { ...ctx, kind: 'incident_fallback', fallbackFromThread: true, orderId: claim.orderId || ctx.orderId };
        const cachedClaim = { ...claim, _ctx: incidentCtx };
        const entry = { id: claim.id, entry: { provider: p, ctx: incidentCtx, claim: cachedClaim } };
        const row = mapClaimToIncidentRow(cachedClaim);
        if (!isNativeIncident) {
          row.source = 'thread_fallback';
          row.remote = true;
        }

        if (isNativeIncident) {
          nativeSeen += 1;
          nativeRows.push(row);
          nativeEntries.push(entry);
        } else {
          fallbackSeen += 1;
          fallbackRows.push(row);
          fallbackEntries.push(entry);
        }
      }

      // Priorité aux vrais incidents BOMP. Si BOMP ne renvoie aucun incident natif,
      // on affiche les fils SAV/litiges comme fallback pour éviter un onglet vide.
      const useFallback = !nativeRows.length && options.includeThreadFallback;
      const selectedRows = useFallback ? fallbackRows : nativeRows;
      const selectedEntries = useFallback ? fallbackEntries : nativeEntries;
      rows.push(...selectedRows);
      incidentEntries.push(...selectedEntries);
      console.log(`[incidents/${p.code || ''}] ${selectedRows.length} ligne(s) incident ajoutée(s), native=${nativeSeen}, fallback=${fallbackSeen}${useFallback ? ' utilisé' : ''}, fenêtre=${providerMaxAgeDays || 'illimitée'}j`);
    } catch (e) {
      console.error(`[incidents/${p.code || ''}] ${e.message}`);
    }
  });

  rows.sort((a, b) => String(b.openedAt || '').localeCompare(String(a.openedAt || '')));
  return { data: rows, incidentEntries, at: Date.now() };
}
async function getIncidentsCached(options = {}, forceRefresh = false) {
  const key = incidentsCacheKey(options);
  const now = Date.now();
  const cached = incidentsCache.get(key);
  const fresh = cached && options.cacheTtlMs > 0 && (now - cached.at) < options.cacheTtlMs;

  if (!forceRefresh && fresh) {
    restoreIncidentsResult(cached);
    return { ...cached, cache: 'HIT', key };
  }
  if (forceRefresh && cached && options.refreshCooldownMs > 0) {
    const last = incidentsLastRefreshStart.get(key) || cached.at || 0;
    if (now - last < options.refreshCooldownMs) {
      restoreIncidentsResult(cached);
      return { ...cached, cache: 'COOLDOWN', key };
    }
  }
  if (incidentsInFlight.has(key)) {
    if (cached && options.staleWhileRefresh) {
      restoreIncidentsResult(cached);
      return { ...cached, cache: 'WAIT-STALE', key };
    }
    const result = await incidentsInFlight.get(key);
    restoreIncidentsResult(result);
    return { ...result, cache: 'WAIT', key };
  }
  if (!forceRefresh && cached && options.staleWhileRefresh) {
    incidentsLastRefreshStart.set(key, now);
    const refresh = collectIncidentsForCache(options)
      .then(result => {
        incidentsCache.set(key, result);
        restoreIncidentsResult(result);
        return result;
      })
      .catch(e => {
        console.error('[incidents/cache refresh]', e.message);
        return cached;
      })
      .finally(() => incidentsInFlight.delete(key));
    incidentsInFlight.set(key, refresh);
    restoreIncidentsResult(cached);
    return { ...cached, cache: 'STALE', key };
  }

  incidentsLastRefreshStart.set(key, now);
  const task = collectIncidentsForCache(options)
    .then(result => {
      incidentsCache.set(key, result);
      restoreIncidentsResult(result);
      return result;
    })
    .finally(() => incidentsInFlight.delete(key));
  incidentsInFlight.set(key, task);
  const result = await task;
  return { ...result, cache: 'MISS', key };
}
function sseSend(res, event, payload) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload || {})}\n\n`);
}

app.get('/api/reclamations/health', (_req, res) => {
  const active = configured().map(p => ({
    code: p.code || 'octopia',
    label: p.label,
    type: p.type
  }));
  res.json({
    ok: true,
    configuredProviders: active,
    configuredCount: active.length,
    message: active.length
      ? 'Proxy actif : au moins une marketplace est configurée.'
      : 'Proxy actif, mais aucune marketplace n’est configurée dans .env.'
  });
});

app.get('/api/reclamations/diagnostic', (_req, res) => {
  res.json({
    ok: true,
    providers: PROVIDERS.map(p => ({
      code: p.code || 'octopia',
      label: p.label,
      type: p.type,
      configured: Boolean(ADAPTERS[p.type] && isConfigured(p)),
      missing: missingConfig(p),
      apiBase: p.type === 'octopia' ? p.auth.apiBase : (p.apiBase || miraklApiBase(p.url || '')),
    })),
  });
});

app.get('/api/reclamations/bomp-auth-check', async (_req, res) => {
  const providers = configured().filter(p => p.type === 'bomp');
  const results = await Promise.all(providers.map(async p => {
    try {
      return await bomp.authCheck(p);
    } catch (e) {
      return {
        ok: false,
        code: p.code,
        label: p.label,
        type: 'bomp',
        apiBase: p.apiBase,
        missing: missingConfig(p),
        authFailed: Boolean(e.authFailed || /ERR_097|Authentication failed/i.test(String(e.message || ''))),
        error: e.message
      };
    }
  }));
  res.status(results.some(r => !r.ok) ? 500 : 200).json({
    ok: results.length > 0 && results.every(r => r.ok),
    count: results.length,
    results
  });
});

app.get('/api/reclamations/notes', async (req, res) => {
  try {
    const options = notesRequestOptions(req.query || {});
    const forceRefresh = parseBoolFlag(req.query.refresh, false);
    const { data, cache } = await getProductNotesCached(options, forceRefresh);

    res.set('Cache-Control', `private, max-age=${Math.floor((options.cacheTtlMs || 0) / 1000)}`);
    res.set('X-Notes-Cache', cache);
    res.set('X-Notes-Fast-Mode', options.fast ? '1' : '0');
    res.json(data);
  } catch (e) {
    const payload = publicErrorPayload(e);
    res.status(payload.status >= 400 && payload.status < 500 ? payload.status : 502).json(payload);
  }
});



app.get('/api/reclamations/cache-status', (_req, res) => {
  res.json({
    ok: true,
    threads: {
      size: threadsCache.size,
      inFlight: threadsInFlight.size,
      entries: threadsCacheDiagnostics(),
    },
    incidents: {
      size: incidentsCache.size,
      inFlight: incidentsInFlight.size,
    },
    notes: {
      size: notesCache.size,
      inFlight: notesInFlight.size,
    },
    now: Date.now(),
  });
});

app.get('/api/reclamations/threads', async (req, res) => {
  try {
    const options = threadsRequestOptions(req);
    const forceRefresh = parseBoolFlag(req.query.refresh, false);
    const cacheOnly = parseBoolFlag(req.query.cacheOnly, false);
    const allowStale = parseBoolFlag(req.query.allowStale ?? req.query.stale, false);

    // Mode lecture cache pure : aucun appel marketplace externe.
    // Utile au front pour afficher instantanément les dernières réclamations connues.
    if (cacheOnly) {
      const cached = getThreadsCacheSnapshot(options, allowStale);
      if (!cached) {
        res.set('Cache-Control', 'no-store');
        res.set('X-Threads-Cache', 'MISS');
        return res.status(204).end();
      }
      res.set('Cache-Control', `private, max-age=${Math.floor((options.cacheTtlMs || 0) / 1000)}`);
      res.set('X-Threads-Cache', cached.cache);
      res.set('X-Threads-Cache-Key', cached.key || '');
      res.set('X-Threads-Cache-Age-Ms', String(cached.ageMs || 0));
      res.set('X-Threads-Count', String(cached.data?.length || 0));
      return res.json(Array.isArray(cached.data) ? cached.data : []);
    }

    const result = await getThreadsCached(options, forceRefresh);

    res.set('Cache-Control', `private, max-age=${Math.floor((options.cacheTtlMs || 0) / 1000)}`);
    res.set('X-Threads-Cache', result.cache);
    res.set('X-Threads-Cache-Key', result.key || '');
    res.set('X-Threads-Cache-Age-Ms', String(result.at ? Math.max(0, Date.now() - result.at) : 0));
    res.set('X-Threads-Count', String(result.data?.length || 0));
    res.json(Array.isArray(result.data) ? result.data : []);
  } catch (e) {
    const payload = publicErrorPayload(e);
    res.status(payload.status >= 400 && payload.status < 500 ? payload.status : 502).json(payload);
  }
});

app.get('/api/reclamations/threads-stream', async (req, res) => {
  const options = threadsRequestOptions(req);
  const forceRefresh = parseBoolFlag(req.query.refresh, false);
  let sentLiveProviderEvents = false;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  try {
    const providers = filteredConfiguredProviders(options.providersFilter, configured()).map(providerPublicInfo);
    sseSend(res, 'start', {
      total: providers.length,
      completed: 0,
      providers,
    });

    const result = await getThreadsCached(options, forceRefresh, (payload) => {
      sentLiveProviderEvents = true;
      sseSend(res, payload?.ok === false ? 'provider-error' : 'provider', payload);
    });

    // Si les données viennent du cache ou d'une attente sur un refresh déjà en cours,
    // aucun événement live n'a été émis. On rejoue les chunks mémorisés pour que le front
    // continue d'afficher au fur et à mesure, sans rappeler les APIs externes.
    if (!sentLiveProviderEvents) {
      const chunks = Array.isArray(result.providerChunks) ? result.providerChunks : [];
      if (chunks.length) {
        for (const chunk of chunks) {
          sseSend(res, chunk?.ok === false ? 'provider-error' : 'provider', {
            ...chunk,
            cache: result.cache,
          });
        }
      } else {
        sseSend(res, 'provider', {
          provider: { type: 'cache', code: 'cache', label: 'Cache serveur' },
          rows: Array.isArray(result.data) ? result.data : [],
          completed: 1,
          total: 1,
          ok: true,
          cache: result.cache,
        });
      }
    }

    sseSend(res, 'done', {
      total: providers.length,
      completed: providers.length,
      count: Array.isArray(result.data) ? result.data.length : 0,
      cache: result.cache,
    });
    res.end();
  } catch (e) {
    sseSend(res, 'fatal', publicErrorPayload(e));
    res.end();
  }
});


app.get('/api/reclamations/incidents', async (req, res) => {
  try {
    const options = incidentsRequestOptions(req);
    const forceRefresh = parseBoolFlag(req.query.refresh, false);
    const result = await getIncidentsCached(options, forceRefresh);

    res.set('Cache-Control', `private, max-age=${Math.floor((options.cacheTtlMs || 0) / 1000)}`);
    res.set('X-Incidents-Cache', result.cache);
    res.set('X-Incidents-Cache-Key', result.key || '');
    res.set('X-Incidents-Count', String(result.data?.length || 0));
    res.json(Array.isArray(result.data) ? result.data : []);
  } catch (e) {
    const payload = publicErrorPayload(e);
    res.status(payload.status >= 400 && payload.status < 500 ? payload.status : 502).json(payload);
  }
});

app.post('/api/reclamations/incidents/:id/message', async (req, res) => {
  try {
    const entry = incidentIndex.get(req.params.id) || claimIndex.get(req.params.id);
    if (!entry) throw new Error('Incident inconnu (rechargez la liste des incidents)');
    const { body, files } = await readReplyPayload(req);
    if (!body) throw Object.assign(new Error('Message vide'), { statusCode: 400 });
    const { provider, ctx } = entry;
    const adapter = ADAPTERS[provider.type];
    if (!adapter?.sendReply) throw new Error(`Réponse incident non gérée pour ${provider.type}`);
    const result = await adapter.sendReply(provider, ctx, body, files);
    res.json({ ok: true, mode: result?.mode || 'reply', files: files.length });
  } catch (e) {
    const payload = publicErrorPayload(e);
    res.status(payload.status >= 400 && payload.status < 500 ? payload.status : 502).json(payload);
  }
});

app.patch('/api/reclamations/incidents/:id', async (req, res) => {
  try {
    const entry = incidentIndex.get(req.params.id) || claimIndex.get(req.params.id);
    if (!entry) throw new Error('Incident inconnu (rechargez la liste des incidents)');
    const { provider, ctx } = entry;
    const adapter = ADAPTERS[provider.type];

    // Fnac/Darty ne fournit pas, dans ce proxy, de fermeture générique sûre pour tous les incidents.
    // On ne simule donc pas une clôture marketplace : l'IHM garde le statut localement.
    if (req.body.status === 'resolu' && adapter.close && ctx.incidentId) {
      await adapter.close(provider, ctx.incidentId);
      return res.json({ ok: true, persisted: true, status: 'resolu' });
    }
    res.json({ ok: true, persisted: false, status: req.body.status || req.body.state || null });
  } catch (e) {
    const payload = publicErrorPayload(e);
    res.status(payload.status >= 400 && payload.status < 500 ? payload.status : 502).json(payload);
  }
});

app.get('/api/reclamations/threads/:id', async (req, res) => {
  try {
    // Le détail peut être demandé depuis l'onglet Réclamations ou depuis l'onglet Incidents.
    // On consulte donc les deux caches en mémoire.
    const entry = claimIndex.get(req.params.id) || incidentIndex.get(req.params.id);

    if (!entry) {
      throw new Error(
        'Réclamation inconnue. Rechargez la liste avant d’ouvrir le détail.'
      );
    }

    const { provider, ctx, claim } = entry;

    // Cas Fnac / Darty : on recharge le fil complet au clic, car la liste reste volontairement légère.
    if (provider.type === 'bomp') {
      if (!claim) {
        throw Object.assign(
          new Error('Réclamation BOMP absente du cache. Rechargez la liste Fnac/Darty puis rouvrez le détail.'),
          { statusCode: 404, provider: provider.code, operation: 'fetchThread' }
        );
      }

      const adapter = ADAPTERS[provider.type];
      let fullClaim;
      try {
        fullClaim = adapter?.fetchThread
          ? await adapter.fetchThread(provider, { ...(ctx || {}), claim })
          : claim;
      } catch (e) {
        console.warn(`[bomp/${provider.code}] détail complet indisponible, retour cache : ${e.message}`);
        fullClaim = claim;
      }

      claimIndex.set(fullClaim.id, {
        provider,
        ctx: fullClaim._ctx || ctx,
        claim: fullClaim
      });

      return res.json(cloneForPublic(fullClaim, provider));
    }

    const adapter = ADAPTERS[provider.type];

    if (!adapter.fetchThread) {
      throw new Error(
        `Le détail n’est pas encore géré pour ${provider.type}`
      );
    }

    const fullClaim =
      await adapter.fetchThread(
        provider,
        ctx
      );

    claimIndex.set(fullClaim.id, {
      provider,
      ctx: fullClaim._ctx || ctx,
      claim: fullClaim
    });

    res.json(cloneForPublic(fullClaim, provider));

  } catch (e) {
    const payload = publicErrorPayload(e);

    res
      .status(
        payload.status >= 400 &&
        payload.status < 500
          ? payload.status
          : 502
      )
      .json(payload);
  }
});

app.get('/api/reclamations/threads/:id/attachments/:messageIndex/:attachmentIndex', async (req, res) => {
  try {
    const entry = claimIndex.get(req.params.id) || incidentIndex.get(req.params.id);
    if (!entry?.claim) throw Object.assign(new Error('Réclamation inconnue. Rechargez la conversation puis réessayez.'), { statusCode: 404 });

    const messageIndex = Number(req.params.messageIndex);
    const attachmentIndex = Number(req.params.attachmentIndex);
    if (!Number.isInteger(messageIndex) || !Number.isInteger(attachmentIndex) || messageIndex < 0 || attachmentIndex < 0) {
      throw Object.assign(new Error('Index de pièce jointe invalide'), { statusCode: 400 });
    }

    const message = Array.isArray(entry.claim.messages) ? entry.claim.messages[messageIndex] : null;
    const attachments = Array.isArray(message?.attachments) ? message.attachments : normalizeInboundAttachments(message);
    const attachment = attachments[attachmentIndex];
    if (!attachment) throw Object.assign(new Error('Pièce jointe introuvable dans cette conversation'), { statusCode: 404 });

    const sourceUrl = attachmentSourceUrl(attachment);
    const sourceId = attachmentSourceId(attachment);
    if (!sourceUrl && !(sourceId && providerCanDownloadAttachmentById(entry.provider))) {
      throw Object.assign(new Error('Cette pièce jointe ne contient ni URL téléchargeable ni identifiant exploitable côté marketplace.'), { statusCode: 404 });
    }

    const adapter = ADAPTERS[entry.provider.type];
    let upstream;
    if (typeof adapter?.downloadAttachment === 'function') {
      upstream = await adapter.downloadAttachment(entry.provider, sourceUrl || sourceId, attachment, entry.ctx, entry.claim);
    } else {
      const raw = String(sourceUrl);
      if (!/^https?:\/\//i.test(raw)) throw Object.assign(new Error(`Téléchargement non géré pour ${entry.provider.type}`), { statusCode: 400 });
      upstream = await fetchWithTimeout(raw, { headers: { Accept: '*/*' } }, Number(process.env.ATTACHMENT_DOWNLOAD_TIMEOUT_MS || 30000));
      await throwHttpError('Pièce jointe', upstream, { provider: entry.provider.code || entry.provider.type, operation: 'downloadAttachment' });
    }

    const filename = safeHeaderFilename(attachment.name || attachment.filename || `piece-jointe-${attachmentIndex + 1}`);
    const contentType = upstream.headers.get('content-type') || attachment.type || 'application/octet-stream';
    const declaredLength = Number(upstream.headers.get('content-length') || 0) || 0;
    const buf = Buffer.from(await upstream.arrayBuffer());

    if (!buf.length) {
      throw Object.assign(new Error('La marketplace a répondu 200, mais le fichier reçu est vide. La pièce jointe est probablement expirée ou non disponible côté marketplace.'), { statusCode: 502 });
    }

    // Certaines instances renvoient un JSON d'erreur avec HTTP 200 au lieu du fichier.
    // On bloque ce cas pour éviter le téléchargement d'un faux fichier du type 0.json.
    if (/application\/json/i.test(contentType)) {
      let detail = '';
      let looksLikeMarketplaceError = false;
      try {
        const j = JSON.parse(buf.toString('utf8'));
        detail = scalarFirst(j.error, j.message, j.errors?.[0]?.message, j.errors?.[0]?.code);
        looksLikeMarketplaceError = Boolean(detail || j.errors || j.error || j.message || j.status);
      } catch (_) {
        detail = buf.toString('utf8').slice(0, 300);
      }
      const genericJsonName = /^(?:\d+|piece-jointe-?\d*)\.json$/i.test(filename);
      if (looksLikeMarketplaceError || genericJsonName || !/\.json$/i.test(filename)) {
        throw Object.assign(new Error(detail || 'La marketplace a renvoyé du JSON au lieu du fichier.'), { statusCode: 502 });
      }
    }

    if (String(process.env.ATTACHMENT_DEBUG || '') === '1') {
      console.log(`[attachment/${entry.provider.code || entry.provider.type}] OK ${filename} type=${contentType} bytes=${buf.length} declared=${declaredLength || 'n/a'}`);
    }

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.setHeader('Content-Length', String(buf.length));
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, Content-Length, Content-Type');
    res.end(buf);
  } catch (e) {
    const payload = publicErrorPayload(e);
    res.status(payload.status >= 400 && payload.status < 500 ? payload.status : 502).json(payload);
  }
});

app.post('/api/reclamations/threads/:id/message', async (req, res) => {
  try {
    console.log('\n========== ENVOI MESSAGE ==========');
    console.log('[SEND] ID demandé :', req.params.id);

    const entry = claimIndex.get(req.params.id);

    if (!entry) {
      console.error('[SEND] Réclamation absente du claimIndex');
      throw new Error('Réclamation inconnue (rechargez la liste)');
    }

    const { provider, ctx } = entry;

    console.log('[SEND] Provider :', {
      code: provider.code,
      type: provider.type
    });

    console.log('[SEND] Context :');
    console.dir(ctx, { depth: null });

    const adapter = ADAPTERS[provider.type];

    const { body, status, files } =
      await readReplyPayload(req);

    console.log('[SEND] Message :');
    console.log(body);

    console.log('[SEND] Status :', status);

    console.log(
      '[SEND] Fichiers :',
      files.map(f => ({
        name: f.originalname,
        size: f.size,
        type: f.mimetype
      }))
    );

    if (!body) {
      throw Object.assign(
        new Error('Message vide'),
        { statusCode: 400 }
      );
    }

    console.log('[SEND] Appel adapter.sendReply()...');

    const result =
      await adapter.sendReply(
        provider,
        ctx,
        body,
        files
      );

    console.log('[SEND] Résultat sendReply :');
    console.dir(result, { depth: null });

    const closeId =
      ctx.discussionId ||
      ctx.incidentId;

    console.log('[SEND] closeId :', closeId);

    if (
      status === 'resolu' &&
      adapter.close &&
      closeId
    ) {
      console.log(
        '[SEND] Fermeture de la réclamation...'
      );

      await adapter.close(
        provider,
        closeId
      );

      console.log(
        '[SEND] Réclamation fermée'
      );
    }

    console.log('[SEND] Réponse OK');
    console.log('==================================\n');

    res.json({
      ok: true,
      status,
      files: files.length
    });
  } catch (e) {
    console.error('\n========== ERREUR ENVOI ==========');
    console.error(e);
    console.error('Stack :');
    console.error(e.stack);
    console.error('=================================\n');

    const payload = publicErrorPayload(e);
    res
      .status(
        payload.status >= 400 &&
          payload.status < 500
          ? payload.status
          : 502
      )
      .json(payload);
  }
});
// Suivi de livraison : GET /api/reclamations/tracking?carrier=colissimo&number=...
app.get('/api/reclamations/tracking', async (req, res) => {
  try {
    const { carrier, number } = req.query;
    const c = CARRIERS[String(carrier || '').toLowerCase()];
    if (!c) throw new Error('Transporteur non géré : ' + carrier);
    if (!number) throw new Error('Numéro de suivi manquant');
    const data = await c.track(number);   // { status, etaH, events:[{at,label}] }
    res.json(normalizeTracking({ ...(data || {}), carrier, number }, data || { carrier, number }));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => console.log(`Proxy réclamations sur http://localhost:${PORT}`));
