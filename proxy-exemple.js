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
    type: 'bomp', code: 'fnac', label: 'Fnac', apiBase: 'https://vendeur.fnac.com/api.php',
    partnerId: process.env.FNAC_PARTNER_ID, shopId: process.env.FNAC_SHOP_ID, key: process.env.FNAC_KEY
  },
  {
    type: 'bomp', code: 'darty', label: 'Darty', apiBase: 'https://vendeur.fnac.com/api.php',
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
    if (!res.ok) throw new Error(`Octopia auth ${res.status}`);
    const j = await res.json();
    tokenCache = { value: j.access_token, exp: Date.now() + (j.expires_in - 300) * 1000 }; // -5 min de marge
    return tokenCache.value;
  }

  async function api(provider, path, opts = {}) {
    const auth = provider.auth;
    const token = await getToken(auth);
    const res = await fetchWithTimeout(`${auth.apiBase}${path}`, {
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
      const txt = await res.text();
      throw new Error(`Octopia ${res.status} (${path}) — ${txt.slice(0, 1000)}`);
    } return res.status === 204 ? {} : res.json();
  }

  function graduationToPriority(g) {
    return (g === 'Claim' || g === 'Level_1') ? 'haute' : 'moyenne';
  }

  return {
    async fetchClaims(provider) {
      // GET /discussions : on récupère les discussions ouvertes
      const data = await api(provider,
        '/discussions?isOpen=true&pageIndex=1&pageSize=25');
      return (data.items || []).map(d => {
        const m = d.message;
        const messages = m ? [{
          from: m.sender?.userType === 'Customer' ? 'client' : 'seller',
          at: new Date(m.createdAt).getTime(),
          text: m.body || '',
        }] : [];
        const marketplace = provider.channelMap[d.salesChannel] || (d.salesChannel || 'octopia').toLowerCase();
        return makeClaim(marketplace, {
          providerType: 'octopia',
          id: d.discussionId,
          customer: d.customerId,                       // l'API ne renvoie pas le nom -> id client
          subject: d.subject,
          orderId: d.orderSellerId || d.orderReference,
          product: d.productId,
          priority: graduationToPriority(d.graduation),
          status: d.isOpen ? (d.status === 'Treated' ? 'attente' : 'nouveau') : 'resolu',
          updatedAt: new Date(d.updatedAt).getTime(),
          messages,
          ctx: { discussionId: d.discussionId, salesChannel: d.salesChannel, customerId: d.customerId },
        });
      });
    },

    // Récupère le fil complet d'une discussion (tous les messages)
    async fetchThread(provider, discussionId) {
      return api(provider, `/discussions/${encodeURIComponent(discussionId)}`);
    },

    async sendReply(provider, ctx, body) {
      // POST /messages — body 13–5000 caractères, destinataire = le client
      await api(provider, '/messages', {
        method: 'POST',
        body: JSON.stringify({
          body,
          discussionId: ctx.discussionId,
          salesChannel: ctx.salesChannel,
          receivers: [{ userId: ctx.customerId, userType: 'Customer' }],
        }),
      });
    },

    async close(provider, discussionId) {
      // PATCH /discussions/{id} — JSON Patch sur isOpen
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
async function throwHttpError(prefix, res) {
  if (res.ok) return;
  let body = '';
  try { body = await res.text(); } catch (_) { }
  throw new Error(`${prefix} ${res.status}${body ? ' — ' + body.slice(0, 300) : ''}`);
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
    const id = thread.id || thread.thread_id || thread.threadId || ctx.threadId;
    const customer = thread.from?.display_name || thread.from?.name || thread.customer?.name || thread.buyer?.name || 'Client';
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
      orderId: thread.entities?.find?.(e => /order/i.test(e.type || e.entity_type || ''))?.id || thread.entities?.[0]?.id || thread.order_id || thread.orderId || thread.order?.id || '',
      product: thread.entities?.find?.(e => /product|offer/i.test(e.type || e.entity_type || ''))?.label || thread.entities?.[0]?.label || thread.product_title || thread.product || thread.offer?.sku || '',
      status: thread.status === 'CLOSED' || thread.closed === true ? 'resolu' : 'nouveau',
      updatedAt: parseMarketplaceDate(rawUpdatedAt),
      messages,
      ctx: { threadId: id, rawUpdatedAt },
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
    if (!ctx?.threadId) throw new Error('Mirakl : threadId manquant');

    // Certaines instances renvoient directement le fil, d'autres un wrapper {data:{...}} ou {thread:{...}}.
    // On demande les messages uniquement au clic, pour garder le chargement initial rapide.
    const data = await this.api(provider, `/inbox/threads/${encodeURIComponent(ctx.threadId)}?with_messages=true`);
    const thread = data?.data || data?.thread || data;
    return this.mapThread(provider, thread, ctx);
  },

  async sendReply(provider, ctx, body) {
    const base = miraklApiBase(provider.url);

    const res = await fetch(
      `${base}/api/inbox/threads/${encodeURIComponent(ctx.threadId)}/message`,
      {
        method: 'POST',
        headers: {
          Authorization: provider.key,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ body }),
      }
    );

    await throwHttpError('Mirakl', res);
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

  async function postXml(provider, operation, body) {
    const res = await fetchWithTimeout(serviceUrl(provider, operation), {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml', Accept: 'text/xml, application/xml' },
      body,
    });
    if (!res.ok) {
      let txt = '';
      try { txt = await res.text(); } catch (_) { }
      throw new Error(`BOMP ${operation} ${res.status}${txt ? ' — ' + txt.slice(0, 300) : ''}`);
    }
    return parser.parse(await res.text());
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

  function mapIncident(provider, it) {
    const msgs = oneOrMany(it.message || it.messages?.message).map(m => ({
      from: (m['@_from'] || m.from) === 'customer' ? 'client' : 'seller',
      at: new Date(m['@_date'] || m.date || Date.now()).getTime(),
      text: m['#text'] || m.content || m.message || '',
    }));
    const incidentId = it['@_id'] || it.incident_id || it.id;
    const orderId = it['@_order_id'] || it.order_id || it.order_fnac_id;
    return makeClaim(provider.code, {
      providerType: 'bomp',
      id: incidentId || orderId || Math.random().toString(36).slice(2),
      customer: it['@_customer'] || it.customer || it.buyer || 'Client',
      subject: normalizeSubject(it['@_reason'] || it.reason || it.subject, msgs.at(-1)?.text),
      orderId,
      product: it['@_product'] || it.product_name,
      priority: 'haute',
      status: String(it['@_status'] || it.status || '').toLowerCase() === 'closed' ? 'resolu' : 'nouveau',
      updatedAt: new Date(it['@_updated_at'] || it.updated_at || Date.now()).getTime(),
      messages: msgs,
      ctx: { incidentId, orderId },
    });
  }

  function mapMessage(provider, m) {
    const id = m.message_id || m.id || m['@_id'];
    return makeClaim(provider.code, {
      providerType: 'bomp',
      id,
      customer: m.client_id || m.customer || 'Client',
      subject: normalizeSubject(m.subject || m.message_subject, m.description || m.message || m.body),
      orderId: m.order_fnac_id || m.order_id || '',
      product: m.offer_seller_id || m.offer_fnac_id || '',
      priority: 'moyenne',
      status: String(m.message_state || m.state || '').toLowerCase().includes('read') ? 'attente' : 'nouveau',
      updatedAt: new Date(m.date || m.created_at || Date.now()).getTime(),
      messages: [{ from: 'client', at: new Date(m.date || Date.now()).getTime(), text: m.description || m.message || m.body || '' }],
      ctx: { messageId: id, orderId: m.order_fnac_id || m.order_id },
    });
  }

  return {
    async fetchClaims(provider) {
      const token = await getToken(provider);
      const claims = [];

      // Réclamations / incidents
      const incidentBody = authedRequest(provider, token, 'incidents_query', '  <paging>1</paging>', ' results_count="100"');
      const incidentsResponse = await postXml(provider, 'incidents_query', incidentBody);
      const ir = incidentsResponse?.incidents_query_response || incidentsResponse?.incidents || incidentsResponse || {};
      const incidents = oneOrMany(ir.incident || ir.incidents?.incident);
      claims.push(...incidents.map(it => mapIncident(provider, it)));

      // Messages clients Fnac/Darty
      const msgBody = authedRequest(provider, token, 'messages_query', '  <paging>1</paging>', ' results_count="100"');
      const messagesResponse = await postXml(provider, 'messages_query', msgBody);
      const mr = messagesResponse?.messages_query_response || messagesResponse?.messages || messagesResponse || {};
      const messages = oneOrMany(mr.message || mr.messages?.message);
      claims.push(...messages.map(m => mapMessage(provider, m)));

      return claims;
    },

    async sendReply(provider, ctx, body) {
      const token = await getToken(provider);
      if (ctx.messageId) {
        const xml = authedRequest(provider, token, 'messages_update',
          `  <message action="reply" id="${xmlEscape(ctx.messageId)}" to="CLIENT">
    <description><![CDATA[${String(body).replace(/]]>/g, ']]]]><![CDATA[>')}]]></description>
    <subject>order_information</subject>
    <type>ORDER</type>
  </message>`);
        await postXml(provider, 'messages_update', xml);
        return;
      }
      throw new Error('Réponse BOMP impossible : identifiant de message introuvable');
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
  const messages = Array.isArray(claim.messages) ? claim.messages.filter(m => m && m.from) : [];
  if (!messages.length) return false; // impossible de confirmer "sans réponse" sans fil de messages
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
    res.status(502).json({ error: e.message });
  }
});

app.post('/api/reclamations/threads/:id/message', async (req, res) => {
  try {
    const entry = claimIndex.get(req.params.id);
    if (!entry) throw new Error('Réclamation inconnue (rechargez la liste)');
    const { provider, ctx } = entry;
    const adapter = ADAPTERS[provider.type];
    await adapter.sendReply(provider, ctx, req.body.body);
    // Si le statut passe à "resolu", on clôt côté marketplace quand c'est supporté.
    const closeId = ctx.discussionId || ctx.incidentId;
    if (req.body.status === 'resolu' && adapter.close && closeId) {
      await adapter.close(provider, closeId);
    }
    res.json({ ok: true, status: req.body.status });
  } catch (e) {
    res.status(502).json({ error: e.message });
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
