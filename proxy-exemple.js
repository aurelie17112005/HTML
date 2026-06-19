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
  if (!raw) return fallback;
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
  // Certains Mirakl, notamment Boulanger, renvoient un code numérique dans topic.value.
  // Ce code ne doit jamais être affiché comme sujet client.
  if (/^[#_\-\s]*\d+[#_\-\s]*$/.test(s)) return true;
  if (/^(topic|subject|reason|motif)[_\-\s]*\d+$/i.test(s)) return true;
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

  async function postXml(provider, operation, body) {
    const res = await fetchWithTimeout(serviceUrl(provider, operation), {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml', Accept: 'text/xml, application/xml' },
      body,
    });
    const txt = await res.text().catch(() => '');
    if (!res.ok) {
      throw Object.assign(new Error(`BOMP ${operation} ${res.status}${txt ? ' — ' + txt.slice(0, 500) : ''}`), { statusCode: 502, provider: provider.code, operation });
    }
    const parsed = parser.parse(txt || '<empty/>');
    const apiError = findBompError(parsed, operation);
    if (apiError) {
      throw Object.assign(new Error(`BOMP ${operation} refusé : ${apiError}`), { statusCode: 502, provider: provider.code, operation });
    }
    return parsed;
  }

  async function getToken(provider) {
    const cached = tokens.get(provider.code);
    if (cached && Date.now() < cached.exp) return cached.value;
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
    const rawMessages = oneOrMany(
      it.message || it.messages?.message || it.thread?.message || it.conversation?.message || it.comment || it.comments?.comment
    );
    const msgs = dedupeMessages(rawMessages.map(m => ({
      from: parseBompAuthor(firstValue(m['@_from'], m.from, m.author, m.message_from, m.from_type, m.sender_type)),
      at: parseBompDate(m['@_date'], m.date, m.created_at, m.updated_at, m.sent_at),
      text: firstValue(m['#text'], m.content, m.message, m.description, m.body, m.text),
    })));

    const incidentId = bompText(it['@_id'], it.incident_id, it.id, it.incidentId);
    const orderId = bompText(it['@_order_id'], it.order_id, it.order_fnac_id, it.order, it.orderId);
    const orderDetailId = bompText(it.order_detail_id, it.order_detail?.order_detail_id, it['@_order_detail_id']);
    const subject = normalizeSubject(
      firstReadableSubject(it['@_reason'], it.reason, it.type, it.incident_type, it.subject, it.title),
      findNewestClientMessage({ messages: msgs })?.text || bompText(it.description, it.message, it.comment)
    );
    const statusRaw = normLower(firstValue(it['@_status'], it.status, it.incident_status, it.state));
    const waitingForSeller = truthyBomp(firstValue(
      it.waiting_for_seller_answer, it['@_waiting_for_seller_answer'],
      it.waiting_seller_answer, it.seller_answer_required, it.answer_required
    ));
    const openedByRaw = firstValue(it.opened_by, it['@_opened_by'], it.created_by, it.author, it.from);
    const openedAt = parseBompDate(it['@_created_at'], it.created_at, it.date_created, it.opened_at, it.date);
    const updatedAt = parseBompDate(it['@_updated_at'], it.updated_at, it.date_updated, it.modified_at, it.last_update, openedAt);

    return makeClaim(provider.code, {
      providerType: 'bomp',
      id: incidentId || orderId || Math.random().toString(36).slice(2),
      customer: bompText(it['@_customer'], it.customer, it.buyer, it.client, it.client_id) || 'Client',
      subject,
      orderId,
      product: bompText(it['@_product'], it.product_name, it.product, it.offer_seller_id, it.offer_fnac_id),
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
        messageId: bompText(it.message_id, it.message?.message_id, it.last_message_id),
        rawType: bompText(it.type, it.incident_type, it.reason),
        openedAt,
        openedBy: parseBompAuthor(openedByRaw),
        waitingForSeller,
        needsReply: waitingForSeller || parseBompAuthor(openedByRaw) === 'client' || findNewestClientMessage({ messages: msgs }),
      },
    });
  }

  function mapMessage(provider, m) {
    const id = bompText(m.message_id, m.id, m['@_id']);
    const orderId = bompText(m.order_fnac_id, m.order_id, m.order);
    const text = bompText(m.description, m.message, m.body, m.content, m.text);
    const author = parseBompAuthor(firstValue(m.message_from, m.from, m.author, m.from_type, m.sender_type, 'customer'));
    return makeClaim(provider.code, {
      providerType: 'bomp',
      id,
      customer: bompText(m.client_id, m.customer, m.buyer) || 'Client',
      subject: normalizeSubject(firstReadableSubject(m.subject, m.message_subject, m.type), text),
      orderId,
      product: bompText(m.offer_seller_id, m.offer_fnac_id, m.product_name),
      priority: 'moyenne',
      status: String(m.message_state || m.state || '').toLowerCase().includes('read') ? 'attente' : 'nouveau',
      updatedAt: parseBompDate(m.date, m.created_at, m.updated_at),
      messages: [{ from: author, at: parseBompDate(m.date, m.created_at, m.updated_at), text }],
      ctx: { kind: 'message', messageId: id, orderId, needsReply: author === 'client' },
    });
  }

  return {
    async fetchClaims(provider) {
      const token = await getToken(provider);
      const claims = [];

      // Réclamations / incidents.
      // On ne filtre pas uniquement sur le dernier message : Darty/Fnac renvoie souvent
      // des incidents sans conversation intégrée, avec seulement le flag waiting_for_seller_answer.
      const incidentBody = authedRequest(provider, token, 'incidents_query', '  <paging>1</paging>', ' results_count="100"');
      const incidentsResponse = await postXml(provider, 'incidents_query', incidentBody);
      const ir = incidentsResponse?.incidents_query_response || incidentsResponse?.incidents || incidentsResponse || {};
      const incidents = extractBompNodes(ir, ['incident']);
      const mappedIncidents = incidents.map(it => mapIncident(provider, it));

      // Messages clients Fnac/Darty. Le parsing est volontairement tolérant car les réponses XML
      // changent légèrement selon Fnac, Darty, messages de commande et messages d'offre.
      const msgBody = authedRequest(provider, token, 'messages_query', '  <paging>1</paging>', ' results_count="100"');
      const messagesResponse = await postXml(provider, 'messages_query', msgBody);
      const mr = messagesResponse?.messages_query_response || messagesResponse?.messages || messagesResponse || {};
      const messages = extractBompNodes(mr, ['message']);
      const mappedMessages = messages.map(m => mapMessage(provider, m)).filter(c => c._ctx.messageId || c.orderId || c.messages.length);

      // Les incidents Fnac/Darty sont parfois séparés de la messagerie.
      // On rattache donc le dernier message de même commande à l'incident pour pouvoir répondre.
      claims.push(...mergeBompMessagesIntoIncidents(mappedIncidents, mappedMessages));
      claims.push(...mappedMessages);

      return claims;
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
  if (ctx.needsReply || ctx.waitingForSeller) return true;

  const messages = Array.isArray(claim.messages) ? claim.messages.filter(m => m && m.from) : [];

  // Fnac/Darty : certains incidents Darty remontent sans conversation dans incidents_query.
  // Avant, ils étaient donc supprimés de /threads car "pas de message".
  if (!messages.length && claim.providerType === 'bomp') return ctx.kind === 'incident' || Boolean(ctx.incidentId);
  if (!messages.length && ctx.kind === 'incident') return true;

  if (!messages.length) return false;
  const last = [...messages].sort((a, b) => normalizeMessageTime(a) - normalizeMessageTime(b)).at(-1);
  return last?.from === 'client';
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

app.get('/api/reclamations/threads', async (req, res) => {
  const all = [];
  claimIndex.clear();

  // Par défaut, ce proxy renvoie uniquement les réclamations auxquelles il faut répondre.
  // Pour tout afficher ponctuellement : /api/reclamations/threads?all=1
  const onlyUnanswered = req.query.all !== '1' && String(req.query.unanswered || '1') !== '0';
  const providers = configured();
  const concurrency = Number(req.query.concurrency || process.env.PROVIDER_CONCURRENCY || 6);

  await mapLimit(providers, concurrency, async (p) => {
    try {
      const fetched = await ADAPTERS[p.type].fetchClaims(p);
      const kept = [];

      for (const rawClaim of fetched) {
        const claim = onlyUnanswered ? await ensureClaimHasMessages(p, rawClaim) : rawClaim;
        if (onlyUnanswered && !claimNeedsReply(claim)) continue;

        claim.subject = normalizeSubject(
          claim.subject,
          Array.isArray(claim.messages) ? [...claim.messages].reverse().find(m => m.from === 'client')?.text : ''
        );
        claimIndex.set(claim.id, { provider: p, ctx: claim._ctx || rawClaim._ctx });
        delete claim._ctx;
        kept.push(claim);
      }

      all.push(...kept);
      console.log(`[${p.type}/${p.code || 'octopia'}] ${kept.length}/${fetched.length} réclamation(s) à répondre`);
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

  const providers = configured().filter(p => p.type === 'bomp');
  const concurrency = Number(req.query.concurrency || process.env.PROVIDER_CONCURRENCY || 6);

  await mapLimit(providers, concurrency, async (p) => {
    try {
      const fetched = await ADAPTERS[p.type].fetchClaims(p);
      for (const claim of fetched) {
        const ctx = claim._ctx || {};
        if (ctx.kind !== 'incident' && !ctx.incidentId) continue;
        incidentIndex.set(claim.id, { provider: p, ctx });
        claimIndex.set(claim.id, { provider: p, ctx });
        all.push(mapClaimToIncidentRow(claim));
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
    const entry = claimIndex.get(req.params.id);
    if (!entry) throw new Error('Réclamation inconnue. Rechargez la liste avant d’ouvrir le détail.');

    const { provider, ctx } = entry;
    const adapter = ADAPTERS[provider.type];
    if (!adapter.fetchThread) throw new Error(`Le détail n’est pas encore géré pour ${provider.type}`);

    const claim = await adapter.fetchThread(provider, ctx);
    claimIndex.set(claim.id, { provider, ctx: claim._ctx || ctx });
    delete claim._ctx;
    res.json(claim);
  } catch (e) {
    const payload = publicErrorPayload(e);
    res.status(payload.status >= 400 && payload.status < 500 ? payload.status : 502).json(payload);
  }
});

app.post('/api/reclamations/threads/:id/message', async (req, res) => {
  try {
    const entry = claimIndex.get(req.params.id);
    if (!entry) throw new Error('Réclamation inconnue (rechargez la liste)');
    const { provider, ctx } = entry;
    const adapter = ADAPTERS[provider.type];
    const { body, status, files } = await readReplyPayload(req);
    if (!body) throw Object.assign(new Error('Message vide'), { statusCode: 400 });
    await adapter.sendReply(provider, ctx, body, files);
    // Si le statut passe à "resolu", on clôt côté marketplace quand c'est supporté.
    const closeId = ctx.discussionId || ctx.incidentId;
    if (status === 'resolu' && adapter.close && closeId) {
      await adapter.close(provider, closeId);
    }
    res.json({ ok: true, status, files: files.length });
  } catch (e) {
    const payload = publicErrorPayload(e);
    res.status(payload.status >= 400 && payload.status < 500 ? payload.status : 502).json(payload);
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
