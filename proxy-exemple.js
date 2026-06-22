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
function makeClaim(marketplace, o) {
  return {
    id: `${marketplace}:${o.providerType}:${o.id}`,   // route la réponse vers le bon adaptateur
    marketplace,
    customer: o.customer || 'Client',
    subject: o.subject || 'Réclamation',
    orderId: o.orderId || '',
    product: o.product || '',
    priority: o.priority || 'moyenne',
    status: o.status || 'nouveau',
    updatedAt: o.updatedAt || Date.now(),
    dueAt: o.dueAt || computeDueAt(o.messages || []),
    messages: o.messages || [],
    _ctx: o.ctx || {},                                // données techniques utiles à la réponse
  };
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

function cleanText(v) {
  return String(v ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function isBadSubject(v) {
  const s = cleanText(v);
  if (!s) return true;
  // Certains opérateurs renvoient un code numérique ou un libellé générique.
  // Ce code/libellé ne doit jamais être affiché comme sujet client.
  if (/^[#_\-\s]*\d+[#_\-\s]*$/.test(s)) return true;
  if (/^(topic|subject|reason|motif)[_\-\s]*\d+$/i.test(s)) return true;
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
  if (/(colis|commande).*(pas|non|jamais).*(reçu|recu|livré|livre)|livré.*rien reçu|non[ -]?reçu/.test(t)) return 'Colis non reçu';
  if (/endommag|cass[ée]e?|fissur|ab[iî]m/.test(t)) return 'Produit endommagé';
  if (/d[ée]fect|panne|ne fonctionne|fonctionne pas|ne s.allume/.test(t)) return 'Produit défectueux';
  if (/non conforme|mauvais[e]? r[ée]f[ée]rence|erreur de r[ée]f[ée]rence|pas celui command/.test(t)) return 'Produit non conforme';
  if (/retour|renvoi|renvoyer|retractation|rétractation/.test(t)) return 'Demande de retour';
  if (/rembours/.test(t)) return 'Remboursement';
  if (/facture/.test(t)) return 'Facture manquante';
  if (/garantie|sav/.test(t)) return 'Question SAV / garantie';
  if (/retard|d[ée]lai|livraison.*d[ée]pass/.test(t)) return 'Retard de livraison';
  return s.length > 70 ? `${s.slice(0, 67)}…` : s;
}
function normalizeSubject(subject, fallbackText = '') {
  return firstReadableSubject(subject) || inferSubjectFromText(fallbackText) || 'Réclamation client';
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

  if (!forceRefresh && cached && options.staleWhileRefresh) {
    if (!notesInFlight.has(key)) {
      const refresh = collectProductNotes(options)
        .then(data => notesCache.set(key, { at: Date.now(), data }))
        .catch(e => console.error('[notes/cache refresh]', e.message))
        .finally(() => notesInFlight.delete(key));
      notesInFlight.set(key, refresh);
    }
    return { data: cached.data, cache: 'STALE', key };
  }

  if (!forceRefresh && notesInFlight.has(key)) {
    const data = await notesInFlight.get(key);
    return { data: data || notesCache.get(key)?.data || [], cache: 'WAIT', key };
  }

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
      const key = `${senderType}|${at}|${text}`;
      if (!text || seen.has(key)) return null;
      seen.add(key);
      return {
        from: /customer|buyer|client/i.test(senderType) ? 'client' : 'seller',
        author: scalarFirst(m.sender?.displayName, m.sender?.name, m.author?.name) || (/customer|buyer|client/i.test(senderType) ? 'Client' : 'Agent'),
        at,
        text,
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
    const isOpen = d.isOpen !== false && !/closed|close|cl[oô]tur/i.test(String(d.status || d.state || ''));
    return makeClaim(marketplace, {
      providerType: 'octopia',
      id: discussionId,
      customer: scalarFirst(d.customer?.name, d.customerName, d.buyer?.name, customerId) || 'Client',
      subject: normalizeSubject(firstReadableSubject(d.subject, d.title, d.topic, d.reason, d.reasonLabel), lastClientText),
      orderId: scalarFirst(d.orderSellerId, d.orderReference, d.orderId, d.order?.id, d.order?.orderId),
      product: scalarFirst(d.productId, d.product?.id, d.product?.title, d.offerSellerId, d.sku),
      priority: graduationToPriority(d.graduation || d.level || d.type),
      status: isOpen ? (/treated|waiting|answered/i.test(String(d.status || d.state || '')) ? 'attente' : 'nouveau') : 'resolu',
      updatedAt: parseMarketplaceDate(d.updatedAt || d.lastUpdateDate || d.lastMessageDate || d.createdAt, Date.now()),
      messages,
      ctx: { discussionId, salesChannel, customerId, kind: 'discussion' },
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
      attachments: (m.attachments || m.files || []).map(a => ({
        name: a.name || a.file_name || a.filename || 'Pièce jointe',
        url: a.url || a.href || a.download_url || '',
        size: a.size || a.file_size || null,
      })),
    };
  },

  mapThread(provider, thread, ctx = {}) {
    const id = scalarFirst(thread.id, thread.thread_id, thread.threadId, thread.uuid, ctx.threadId);
    const customer = scalarFirst(thread.from?.display_name, thread.from?.name, thread.customer?.name, thread.buyer?.name) || 'Client';
    const rawUpdatedAt = thread.date_updated || thread.updated_at || thread.last_message_date || thread.date_created || thread.created_at || null;
    const messages = this.extractMessages(thread).map(m => this.mapMessage(m, customer));
    const lastClientText = [...messages].reverse().find(m => m.from === 'client')?.text || '';

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
      orderId: scalarFirst(thread.entities?.find?.(e => /order/i.test(e.type || e.entity_type || ''))?.id, thread.order_id, thread.orderId, thread.order?.id, thread.entities?.[0]?.id),
      product: scalarFirst(thread.entities?.find?.(e => /product|offer/i.test(e.type || e.entity_type || ''))?.label, thread.product_title, thread.product, thread.offer?.sku, thread.entities?.[0]?.label),
      status: thread.status === 'CLOSED' || thread.closed === true ? 'resolu' : 'nouveau',
      updatedAt: parseMarketplaceDate(rawUpdatedAt),
      messages,
      ctx: {
        threadId: id,
        rawUpdatedAt,
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
    const orderId = scalarFirst(order.order_id, order.id, order.commercial_id, order.orderId);
    const customer = scalarFirst(
      order.customer?.firstname && order.customer?.lastname ? `${order.customer.firstname} ${order.customer.lastname}` : '',
      order.customer?.name, order.customer_name, order.buyer?.name, order.customer?.email
    );
    const lines = order.order_lines || order.lines || order.orderLines || [];
    const firstLine = Array.isArray(lines) ? (lines[0] || {}) : lines;
    const product = scalarFirst(
      firstLine.product_title, firstLine.product?.title, firstLine.offer_sku, firstLine.offer_id,
      firstLine.product?.sku, order.product_title
    );
    const ean = scalarFirst(
      firstLine.product_sku, firstLine.product?.sku, firstLine.product?.id, firstLine.offer_sku,
      firstLine.product_id, firstLine.product_reference
    );
    return { orderId, customer, product, ean };
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

  async fetchClaims(provider) {
    const threads = await this.fetchAllThreads(provider);
    return threads.map(t => this.mapThread(provider, t));
  },

  async fetchThread(provider, ctx) {
    const threadId = scalarFirst(ctx?.threadId, ctx?.id);
    if (!threadId) throw Object.assign(new Error('Mirakl : threadId manquant ou invalide'), { statusCode: 400, provider: provider.code, operation: 'fetchThread' });

    // Certaines instances renvoient directement le fil, d'autres un wrapper {data:{...}} ou {thread:{...}}.
    // On demande les messages uniquement au clic, pour garder le chargement initial rapide.
    const data = await this.api(provider, `/inbox/threads/${encodeURIComponent(threadId)}?with_messages=true`);
    const thread = data?.data || data?.thread || data;
    return this.mapThread(provider, thread, { ...ctx, threadId });
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

  function looksLikeBompOrderId(v) {
    const s = cleanText(v);
    // Exemples Fnac vus dans la doc/librairies : 07LWQ6278YJUI, LDJEDEAS123.
    // On évite de prendre un statut, une date ou un compteur à la place du numéro.
    return /^[A-Z0-9][A-Z0-9_-]{5,40}$/i.test(s)
      && !/^(true|false|yes|no|open|opened|closed|created|accepted|refused|unread|read|archived|client|seller)$/i.test(s);
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
      obj?.order?.order_fnac_id, obj?.order?.order_id, obj?.order?.['@_order_id'], obj?.order?.['@_id'], obj?.order
    ) || bompDeepText(obj, [
      'order_fnac_id', 'order_id', 'orderId', 'fnac_order_id', 'darty_order_id',
      'order_reference', 'order_ref', 'order_number', 'client_order_id', '@_order_id', '@_order_fnac_id'
    ]);
    if (exact && looksLikeBompOrderId(exact)) return exact;
    return bompFuzzyText(obj, [
      'order_fnac_id', 'orderid', 'order_id', 'fnacorderid', 'dartyorderid', 'orderreference', 'ordernumber', 'orderref', 'messagereferer'
    ], [
      'orderdetail', 'detailid', 'lineid', 'nbmessage', 'messagecount', 'status', 'state', 'date', 'rate', 'amount', 'price'
    ], looksLikeBompOrderId);
  }

  function extractBompOrderDetailId(obj) {
    return bompText(
      obj?.order_detail_id, obj?.orderDetailId, obj?.order_detail?.order_detail_id,
      obj?.order_detail?.['@_order_detail_id'], obj?.['@_order_detail_id']
    ) || bompDeepText(obj, ['order_detail_id', 'orderDetailId', 'order_detail_fnac_id', 'order_line_id', 'line_id', '@_order_detail_id'])
      || bompFuzzyText(obj, ['orderdetailid', 'lineid'], ['orderid']);
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

  function bompQueryXml(provider, token, operation, elements = {}, resultsCount = 100) {
    // Si une requête précédente a forcé une ré-authentification, on prend
    // automatiquement le dernier token en cache plutôt que l'ancien token local.
    const activeToken = tokens.get(provider.code)?.value || token;
    const inner = Object.entries(elements)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => Array.isArray(v)
        ? v.map(item => `  <${k}>${xmlEscape(item)}</${k}>`).join('\n')
        : `  <${k}>${xmlEscape(v)}</${k}>`)
      .filter(Boolean)
      .join('\n') || '  <paging>1</paging>';
    const attrs = resultsCount ? ` results_count="${xmlEscape(resultsCount)}"` : '';
    return authedRequest(provider, activeToken, operation, inner, attrs);
  }

  function mergeClaimDetails(base, detail) {
    if (!base || !detail) return base;
    if (!base.orderId && detail.orderId) base.orderId = detail.orderId;
    if ((!base.customer || base.customer === 'Client') && detail.customer && detail.customer !== 'Client') base.customer = detail.customer;
    if (!base.product && detail.product) base.product = detail.product;
    if (isBadSubject(base.subject) && detail.subject && !isBadSubject(detail.subject)) base.subject = detail.subject;
    if ((!base.messages || !base.messages.length) && detail.messages?.length) base.messages = detail.messages;
    else base.messages = dedupeMessages([...(base.messages || []), ...(detail.messages || [])]);
    base.updatedAt = Math.max(Number(base.updatedAt || 0), Number(detail.updatedAt || 0)) || base.updatedAt || detail.updatedAt;
    base.dueAt = computeDueAt(base.messages || []);
    base._ctx = { ...(base._ctx || {}), ...(detail._ctx || {}), orderId: base.orderId || detail.orderId || base._ctx?.orderId };
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

  function mapOrderInfo(o) {
    const orderId = extractBompOrderId(o);
    if (!orderId) return null;
    const first = bompDeepText(o, ['client_firstname', 'buyer_firstname', 'firstname']);
    const last = bompDeepText(o, ['client_lastname', 'buyer_lastname', 'lastname']);
    const customer = [first, last].filter(Boolean).join(' ').trim()
      || bompDeepText(o, ['client_id', 'client_email', 'customer_name', 'buyer_name', 'client_name']);
    const product = bompDeepText(o, ['product_name', 'product_label', 'product_title', 'title', 'description'])
      || bompDeepText(o, ['offer_seller_id', 'offer_fnac_id', 'seller_sku', 'sku', 'ean']);
    const ean = bompDeepText(o, ['ean', 'product_ean', 'gtin', 'offer_seller_id', 'seller_sku', 'sku']);
    return { orderId, customer: cleanText(customer), product: cleanText(product), ean: cleanText(ean) };
  }

  function enrichClaimFromOrderInfo(claim, infoByOrderId) {
    const info = claim?.orderId ? infoByOrderId.get(claim.orderId) : null;
    if (!info) return claim;
    if ((!claim.customer || claim.customer === 'Client') && info.customer) claim.customer = info.customer;
    if (!claim.product && info.product) claim.product = info.product;
    claim._ctx = { ...(claim._ctx || {}), orderId: claim.orderId };
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

  function mapEmbeddedBompMessage(m, defaultAuthor = 'client') {
    return {
      from: parseBompAuthor(firstValue(
        m['@_from'], m.from, m.author, m.message_from, m.from_type, m.sender_type,
        m.created_by, m.origin, m.source, m.is_customer ? 'client' : '', defaultAuthor
      )),
      at: parseBompDate(
        m['@_date'], m.date, m.created_at, m.createdAt, m.updated_at, m.updatedAt,
        m.sent_at, m.creation_date, m.modification_date
      ),
      text: extractBompClientText(m)
    };
  }

  function dedupeMessages(messages) {
    const seen = new Set();
    return (messages || [])
      .filter(m => m && (m.text || m.body || m.message))
      .map(m => ({
        from: m.from || parseBompAuthor(m.author || m.message_from || m.from_type || m['@_from']),
        at: Number(m.at) || parseBompDate(m.rawAt || m.date || m.created_at || m.updated_at),
        text: cleanText(m.text || m.body || m.message || m.description || m.content || ''),
      }))
      .filter(m => {
        const key = `${m.from}|${m.at}|${m.text}`;
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
    const statusRaw = normLower(firstValue(it['@_status'], it.status, it.incident_status, it.state) || bompDeepText(it, [
      'status', 'incident_status', 'state', 'state_label'
    ]));
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
      customer: bompText(it['@_customer'], it.customer, it.buyer, it.client, it.client_id) || bompDeepText(it, [
        'customer', 'customer_name', 'buyer', 'buyer_name', 'client', 'client_name', 'client_id', 'buyer_id'
      ]) || 'Client',
      subject,
      orderId,
      product: bompText(it['@_product'], it.product_name, it.product, it.offer_seller_id, it.offer_fnac_id) || bompDeepText(it, [
        'product', 'product_name', 'product_label', 'product_title', 'title', 'offer_seller_id', 'offer_fnac_id', 'seller_sku', 'sku', 'ean'
      ]),
      priority: 'haute',
      status: /closed|close|clos|resolved|resolu|résolu/.test(statusRaw) ? 'resolu' : 'nouveau',
      updatedAt,
      dueAt: computeDueAt(msgs.length ? msgs : [{ from: 'client', at: openedAt }]),
      messages: msgs,
      ctx: {
        kind: 'incident',
        incidentId,
        orderId,
        orderDetailId,
        messageId: extractBompMessageId(it),
        rawType: bompText(it.type, it.incident_type, it.reason) || bompDeepText(it, ['type', 'incident_type', 'reason', 'motif']),
        openedAt,
        updatedAt,
        openedBy: parseBompAuthor(openedByRaw),
        waitingForSeller,
        // Ne pas considérer "un client a écrit un jour" comme "à répondre" :
        // la vraie décision se fait plus bas avec le dernier message.
        // Exception : certains incidents Fnac/Darty n'ont pas de conversation exploitable.
        needsReply: waitingForSeller || (!msgs.length && parseBompAuthor(openedByRaw) === 'client'),
      },
    });
  }

  function mapMessage(provider, m, defaultOrderId = '') {
    const id = extractBompMessageId(m);
    const orderId = extractBompOrderId(m) || defaultOrderId;
    const text = extractBompClientText(m);
    const author = parseBompAuthor(firstValue(m.message_from, m.from, m.author, m.from_type, m.sender_type, 'customer'));
    const at = parseBompDate(
      m.date, m.created_at, m.createdAt, m.updated_at, m.updatedAt, m.sent_at, m.creation_date,
      bompDeepText(m, ['date', 'created_at', 'createdAt', 'updated_at', 'updatedAt', 'sent_at', 'creation_date'])
    );
    return makeClaim(provider.code, {
      providerType: 'bomp',
      id: id || orderId || Math.random().toString(36).slice(2),
      customer: bompText(m.client_id, m.customer, m.buyer) || bompDeepText(m, [
        'customer', 'customer_name', 'buyer', 'buyer_name', 'client', 'client_name', 'client_id', 'buyer_id'
      ]) || 'Client',
      subject: normalizeSubject(firstReadableSubject(
        m.subject, m.message_subject, m.type,
        bompDeepText(m, ['subject', 'message_subject', 'reason', 'reason_label', 'motif', 'type'])
      ), text),
      orderId,
      product: bompText(m.offer_seller_id, m.offer_fnac_id, m.product_name) || bompDeepText(m, [
        'product', 'product_name', 'product_label', 'product_title', 'offer_seller_id', 'offer_fnac_id', 'seller_sku', 'sku', 'ean'
      ]),
      priority: 'moyenne',
      status: String(m.message_state || m.state || '').toLowerCase().includes('read') ? 'attente' : 'nouveau',
      updatedAt: at,
      messages: text ? [{ from: author, at, text }] : [],
      ctx: { kind: 'message', messageId: id, orderId, needsReply: author === 'client' },
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
    if (clientText) messages.push({ from: 'client', at, text: clientText });
    if (sellerReply) messages.push({ from: 'seller', at, text: sellerReply });

    return makeClaim(provider.code, {
      providerType: 'bomp',
      id: commentId || orderId || Math.random().toString(36).slice(2),
      customer: bompText(c.client_id, c.customer, c.buyer) || bompDeepText(c, [
        'customer', 'customer_name', 'buyer', 'buyer_name', 'client', 'client_name', 'client_id', 'buyer_id'
      ]) || 'Client',
      subject: normalizeSubject(firstReadableSubject(
        c.subject, c.type, bompDeepText(c, ['subject', 'message_subject', 'reason', 'reason_label', 'motif', 'type'])
      ), clientText),
      orderId,
      product: bompText(c.offer_seller_id, c.offer_fnac_id, c.product_name) || bompDeepText(c, [
        'product', 'product_name', 'product_label', 'product_title', 'offer_seller_id', 'offer_fnac_id', 'seller_sku', 'sku', 'ean'
      ]),
      priority: 'moyenne',
      status: sellerReply ? 'attente' : 'nouveau',
      updatedAt: at,
      messages,
      ctx: {
        kind: 'order_comment',
        commentId,
        orderId,
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
      'product', 'product_name', 'product_label', 'product_title', 'offer_seller_id', 'offer_fnac_id', 'seller_sku', 'sku', 'ean'
    ]);
    const ean = bompDeepText(c, ['ean', 'product_ean', 'gtin', 'offer_seller_id', 'seller_sku', 'sku']);

    return makeProductNote(provider.code, {
      providerType: 'bomp',
      id: commentId || orderId,
      orderId,
      customer: bompText(c.client_id, c.customer, c.buyer) || bompDeepText(c, [
        'customer', 'customer_name', 'buyer', 'buyer_name', 'client', 'client_name', 'client_id', 'buyer_id'
      ]) || 'Client',
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

    async fetchClaims(provider) {
      const token = await getToken(provider);
      const claims = [];
      const errors = [];
      const enrichLimit = Number(process.env.BOMP_ENRICH_LIMIT || 50);

      async function safeQuery(operation, xml, label = operation) {
        try {
          return await postXml(provider, operation, xml);
        } catch (e) {
          errors.push({ operation: label, message: e.message, statusCode: e.statusCode });
          console.warn(`[bomp/${provider.code}] ${label} ignoré : ${e.message}`);
          return null;
        }
      }

      // 1) Requêtes larges : on récupère les incidents, messages et commentaires disponibles.
      const incidentsResponse = await safeQuery(
        'incidents_query',
        bompQueryXml(provider, token, 'incidents_query', { paging: 1 }, 100)
      );
      const ir = incidentsResponse?.incidents_query_response || incidentsResponse?.incidents || incidentsResponse || {};
      const incidents = incidentsResponse ? extractBompNodes(ir, ['incident']) : [];
      let mappedIncidents = incidents.map(it => mapIncident(provider, it));

      const messagesResponse = await safeQuery(
        'messages_query',
        bompQueryXml(provider, token, 'messages_query', { paging: 1 }, 100)
      );
      const mr = messagesResponse?.messages_query_response || messagesResponse?.messages || messagesResponse || {};
      const messages = messagesResponse ? extractBompNodes(mr, ['message']) : [];
      let mappedMessages = messages
        .map(m => mapMessage(provider, m))
        .filter(c => c._ctx.messageId || c.orderId || c.messages.length);

      const commentsResponse = await safeQuery(
        'client_order_comments_query',
        bompQueryXml(provider, token, 'client_order_comments_query', { paging: 1 }, 100)
      );
      const cr = commentsResponse?.client_order_comments_query_response || commentsResponse?.client_order_comments || commentsResponse || {};
      const comments = commentsResponse ? extractBompNodes(cr, ['client_order_comment', 'comment']) : [];
      let mappedComments = comments
        .map(c => mapClientOrderComment(provider, c))
        .filter(c => c.orderId || c.messages.length);

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
      const orderIds = [...new Set([
        ...mappedIncidents.map(c => c.orderId),
        ...mappedMessages.map(c => c.orderId),
        ...mappedComments.map(c => c.orderId),
      ].filter(Boolean))].slice(0, enrichLimit);

      const perOrderMessages = [];
      const perOrderComments = [];
      const orderInfos = [];

      for (const orderId of orderIds) {
        const msgByOrderResponse = await safeQuery(
          'messages_query',
          bompQueryXml(provider, token, 'messages_query', { paging: 1, order_fnac_id: orderId }, 100),
          `messages_query/order_fnac_id:${orderId}`
        );
        const mor = msgByOrderResponse?.messages_query_response || msgByOrderResponse?.messages || msgByOrderResponse || {};
        const msgByOrder = msgByOrderResponse ? extractBompNodes(mor, ['message']) : [];
        perOrderMessages.push(...msgByOrder.map(m => mapMessage(provider, m, orderId)).filter(c => c._ctx.messageId || c.orderId || c.messages.length));

        const comByOrderResponse = await safeQuery(
          'client_order_comments_query',
          bompQueryXml(provider, token, 'client_order_comments_query', { paging: 1, order_fnac_id: orderId }, 100),
          `client_order_comments_query/order_fnac_id:${orderId}`
        );
        const cor = comByOrderResponse?.client_order_comments_query_response || comByOrderResponse?.client_order_comments || comByOrderResponse || {};
        const comByOrder = comByOrderResponse ? extractBompNodes(cor, ['client_order_comment', 'comment']) : [];
        perOrderComments.push(...comByOrder.map(c => mapClientOrderComment(provider, c, orderId)).filter(c => c.orderId || c.messages.length));

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
      const messageLikeClaims = mergeClaimsByIncidentOrOrder([...mappedMessages, ...mappedComments]);
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

      return mergeClaimsByIncidentOrOrder(claims);
    },

    async sendReply(provider, ctx, body) {
      const token = await getToken(provider);
      const messageId = scalarFirst(ctx?.messageId, ctx?.id);
      const orderId = scalarFirst(ctx?.orderId, ctx?.order_fnac_id, ctx?.order);
      const safeBody = String(body || '').trim().replace(/]]>/g, ']]]]><![CDATA[>');
      if (!safeBody) throw Object.assign(new Error('Message vide'), { statusCode: 400, provider: provider.code, operation: 'sendReply' });

      // Chemin fiable : les messages Fnac/Darty se répondent via messages_update + message_id.
      // Cf. fnapy : update_messages permet l'action reply avec description, subject et type.
      if (messageId) {
        const xml = authedRequest(provider, token, 'messages_update',
          `  <message action="reply" id="${xmlEscape(messageId)}" to="CLIENT">
    <description><![CDATA[${safeBody}]]></description>
    <subject>order_information</subject>
    <type>ORDER</type>
  </message>`);
        await postXml(provider, 'messages_update', xml);
        return { mode: 'messages_update' };
      }

      // Secours officiel BOMP : réponse à un commentaire client via l'id de commande FNAC/Darty.
      if (orderId) {
        const xml = authedRequest(provider, token, 'client_order_comments_update',
          `  <comment id="${xmlEscape(orderId)}">
    <comment_reply><![CDATA[${safeBody}]]></comment_reply>
  </comment>`);
        await postXml(provider, 'client_order_comments_update', xml);
        return { mode: 'client_order_comments_update' };
      }

      throw Object.assign(new Error('Réponse BOMP impossible : aucun message_id ni order_id exploitable pour cet incident'), { statusCode: 400, provider: provider.code, operation: 'sendReply' });
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
  if (/incident|échec|echec|absent|retour|refus|exception|problème/.test(t)) return 'incident';
  if (/préparation|preparation|étiquette|label|enregistr|created|annonce/.test(t)) return 'en_attente';
  return 'en_transit';
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
      return { status: events[0] ? mapStatus(events[0].label) : 'en_transit', etaH: null, events };
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
      return { status: evs[0] ? mapStatus(evs[0].label) : 'en_transit', etaH: null, events: evs };
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
      return { status: evs[0] ? mapStatus(evs[0].label) : 'en_transit', etaH: null, events: evs };
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
      return { status: evs[0] ? mapStatus(evs[0].label) : 'en_transit', etaH: null, events: evs };
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
      return { status: evs[0] ? mapStatus(evs[0].label) : 'en_transit', etaH: null, events: evs };
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
        status: s.status?.statusCode === 'delivered' ? 'livre' : (evs[0] ? mapStatus(evs[0].label) : 'en_transit'),
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
      return { status: evs[0] ? mapStatus(evs[0].label) : 'en_transit', etaH: null, events: evs };
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
      return { status: evs[0] ? mapStatus(evs[0].label) : 'en_transit', etaH: null, events: evs };
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
  if (!claim || claim.status === 'resolu') return false;
  const ctx = claim._ctx || {};
  const messages = Array.isArray(claim.messages) ? claim.messages.filter(m => m && m.from) : [];

  // Source la plus fiable : le dernier message de la conversation.
  // Si la boutique a répondu après le client, on ne doit plus afficher la réclamation.
  if (messages.length) {
    const last = [...messages].sort((a, b) => normalizeMessageTime(a) - normalizeMessageTime(b)).at(-1);
    return last?.from === 'client';
  }

  // Flags explicites renvoyés par la marketplace ou déduits au mapping.
  if (ctx.waitingForSeller === true || ctx.needsReply === true) return true;

  // Cas BOMP important : incidents_query renvoie parfois uniquement un résumé d'incident
  // avec incident_id + order_id, mais sans fil de messages. Avant, on les supprimait tous,
  // ce qui donnait 0 réclamation côté Fnac/Darty malgré raw incidents/mapped > 0.
  // La fenêtre de date reste appliquée juste après pour éviter de ressortir l'historique.
  if (ctx.kind === 'incident' && ctx.incidentId && claim.marketplace && ['fnac', 'darty'].includes(String(claim.marketplace).toLowerCase())) {
    return true;
  }

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
async function ensureClaimHasMessages(provider, claim) {
  if (claim?.messages?.length) return claim;
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

app.get('/api/reclamations/threads', async (req, res) => {
  const all = [];
  claimIndex.clear();

  // Par défaut, ce proxy renvoie uniquement les réclamations auxquelles il faut répondre.
  // Pour tout afficher ponctuellement : /api/reclamations/threads?all=1
  const onlyUnanswered = req.query.all !== '1' && String(req.query.unanswered || '1') !== '0';
  const maxAgeDays = resolveMaxAgeDays(req, onlyUnanswered);
  const providers = configured();
  const concurrency = Number(req.query.concurrency || process.env.PROVIDER_CONCURRENCY || 6);

  await mapLimit(providers, concurrency, async (p) => {
    try {
      const fetched = await ADAPTERS[p.type].fetchClaims(p);
      const providerMaxAgeDays = resolveMaxAgeDays(req, onlyUnanswered, p);
      const kept = [];

      for (const rawClaim of fetched) {
        const claim = onlyUnanswered ? await ensureClaimHasMessages(p, rawClaim) : rawClaim;
        if (onlyUnanswered && !claimNeedsReply(claim)) continue;
        if (!claimIsRecentEnough(claim, providerMaxAgeDays)) continue;

        claim.subject = normalizeSubject(
          claim.subject,
          Array.isArray(claim.messages) ? [...claim.messages].reverse().find(m => m.from === 'client')?.text : ''
        );
        const ctx = claim._ctx || rawClaim._ctx;
        claimIndex.set(claim.id, { provider: p, ctx, claim: { ...claim, _ctx: ctx } });
        delete claim._ctx;
        kept.push(claim);
      }

      all.push(...kept);
      console.log(`[${p.type}/${p.code || 'octopia'}] ${kept.length}/${fetched.length} réclamation(s) à répondre, fenêtre=${providerMaxAgeDays || 'illimitée'}j`);
    } catch (e) {
      console.error(`[${p.type}/${p.code || ''}] ${e.message}`); // une MP en panne n'empêche pas les autres
    }
  });

  all.sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
  res.json(all);
});


app.get('/api/reclamations/incidents', async (req, res) => {
  const all = [];
  incidentIndex.clear();

  const onlyUnanswered = req.query.all !== '1' && String(req.query.unanswered || '1') !== '0';
  const maxAgeDays = resolveMaxAgeDays(req, onlyUnanswered);
  const providers = configured().filter(p => p.type === 'bomp');
  const concurrency = Number(req.query.concurrency || process.env.PROVIDER_CONCURRENCY || 6);

  await mapLimit(providers, concurrency, async (p) => {
    try {
      const fetched = await ADAPTERS[p.type].fetchClaims(p);
      const providerMaxAgeDays = resolveMaxAgeDays(req, onlyUnanswered, p);
      for (const rawClaim of fetched) {
        const claim = onlyUnanswered ? await ensureClaimHasMessages(p, rawClaim) : rawClaim;
        const ctx = claim._ctx || rawClaim._ctx || {};
        if (ctx.kind !== 'incident' && !ctx.incidentId) continue;
        if (onlyUnanswered && !claimNeedsReply(claim)) continue;
        if (!claimIsRecentEnough(claim, providerMaxAgeDays)) continue;

        // Important : on garde aussi l'objet complet en cache.
        // L'IHM peut ensuite appeler /threads/:id pour afficher le détail BOMP.
        // Avant, seul le contexte était stocké, ce qui provoquait
        // “Réclamation BOMP absente du cache” au clic sur le détail.
        const cachedClaim = { ...claim, _ctx: ctx };
        incidentIndex.set(claim.id, { provider: p, ctx, claim: cachedClaim });
        claimIndex.set(claim.id, { provider: p, ctx, claim: cachedClaim });

        all.push(mapClaimToIncidentRow(cachedClaim));
      }
    } catch (e) {
      console.error(`[incidents/${p.code || ''}] ${e.message}`);
    }
  });

  all.sort((a, b) => String(b.openedAt || '').localeCompare(String(a.openedAt || '')));
  res.json(all);
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

    // Cas Fnac / Darty
    if (provider.type === 'bomp') {
      if (!claim) {
        throw Object.assign(
          new Error('Réclamation BOMP absente du cache. Rechargez la liste Fnac/Darty puis rouvrez le détail.'),
          { statusCode: 404, provider: provider.code, operation: 'fetchThread' }
        );
      }

      const copy = typeof structuredClone === 'function'
        ? structuredClone(claim)
        : JSON.parse(JSON.stringify(claim));

      delete copy._ctx;

      return res.json(copy);
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

    delete fullClaim._ctx;

    res.json(fullClaim);

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
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => console.log(`Proxy réclamations sur http://localhost:${PORT}`));
