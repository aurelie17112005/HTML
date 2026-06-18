# Centre de réclamations Marketplaces — Guide de branchement

Cette page (`reclamations-marketplaces.html`) centralise les réclamations de
**toutes vos marketplaces** dans une seule interface : liste filtrable, statuts/suivi,
réponse au client, stats & alertes SLA.

Elle fonctionne **immédiatement en mode démo** (données fictives). Pour l'alimenter
avec vos vraies données, suivez ce guide.

---

## 1. Important : chaque marketplace a sa propre API

Contrairement à une idée répandue, vos marketplaces n'utilisent **pas toutes la même
technologie**. État des lieux (mi-2026) :

| Marketplace | Technologie d'API | Adaptateur |
|---|---|---|
| **Cdiscount** | **Octopia** (filiale Cdiscount, API REST sur `dev.cdiscount.com` ; l'ancienne API SOAP a fermé en 2025) | `octopia` |
| **Fnac** | **BOMP** — Back Office Marketplace Fnac Darty, solution **interne** (a quitté Mirakl, « Fnac Mirakl » obsolète depuis le 30/06/2025) | `bomp` |
| **Darty** | **BOMP** — même plateforme interne que Fnac | `bomp` |
| **Rakuten** (FR) | API propre (ex-PriceMinister) | `rakuten` |
| **Carrefour, La Redoute, Decathlon, Leroy Merlin…** | **Mirakl** (API unifiée, identique pour tous) | `mirakl` |

L'avantage : pour **toutes** les marketplaces Mirakl, un **seul** adaptateur suffit —
seuls l'URL de l'opérateur et la clé API changent.

---

## 2. Pourquoi un « proxy » backend est indispensable

Le navigateur **ne doit pas** appeler ces API directement :

1. **Sécurité** — vos clés API seraient visibles dans le code de la page, donc
   exploitables par n'importe quel visiteur.
2. **CORS** — ces API refusent les appels venant directement d'un navigateur.

La solution : un **proxy** côté serveur. La page appelle votre serveur ; votre serveur
ajoute la clé API (secrète) et relaie vers la bonne marketplace.

```
Navigateur (la page)  ──►  Votre proxy (clés secrètes + adaptateurs)  ──►  Octopia / BOMP / Mirakl / Rakuten
```

---

## 3. Architecture multi-adaptateurs

Le fichier `proxy-exemple.js` implémente un **adaptateur par technologie**. Chaque
adaptateur expose deux fonctions et renvoie le **même format `claim`** :

```
adapters = {
  mirakl  : { fetchClaims(mp), sendReply(mp, id, body) },   // ✅ endpoints connus, remplis
  octopia : { … },   // ⚠ endpoints à compléter avec la doc Cdiscount/Octopia
  bomp    : { … },   // ⚠ endpoints à compléter avec la doc Fnac Darty
  rakuten : { … },   // ⚠ endpoints à compléter avec la doc Rakuten
}
```

Les marketplaces sont déclarées dans le tableau `MARKETPLACES` du proxy
(`code`, `label`, `type`, `url`, `key`). Ajoutez autant d'opérateurs Mirakl que
voulu : ils réutilisent tous l'adaptateur `mirakl`.

### Endpoints Mirakl (déjà renseignés)

| Action | Méthode + endpoint |
|---|---|
| Lister les fils | `GET /api/inbox/threads?with_messages=true&entity_type=MMP_ORDER` |
| Lire un fil | `GET /api/inbox/threads/{thread_id}` |
| Répondre | `POST /api/inbox/threads/{thread_id}/message` |
| Pièce jointe | `GET /api/inbox/threads/{attachment_id}/download` |

Auth Mirakl : en-tête `Authorization: <clé API>` (clé dans le back-office vendeur).

### Endpoints Octopia (déjà renseignés) — Cdiscount, Rakuten, Alltricks…

L'API Octopia « Discussions » (v2) est désormais **entièrement câblée** dans le proxy.
Un seul compte Octopia couvre plusieurs canaux de vente (Cdiscount = `CDISFR`,
mais aussi Rakuten, Alltricks, OnBuy, CDON, Joom, Fyndiq, Kingfisher).

Authentification : **OAuth2 `client_credentials`** (pas de clé API longue durée).

| Action | Méthode + endpoint |
|---|---|
| Générer un token (valable 2 h) | `POST https://auth.octopia-io.net/auth/realms/maas/protocol/openid-connect/token` |
| Lister les discussions ouvertes | `GET /seller/v2/discussions?isOpen=true&includeMessages=LastMessage` |
| Détail d'une discussion | `GET /seller/v2/discussions/{discussionId}` |
| Répondre | `POST /seller/v2/messages` (body 13–5000 car., `receivers` = client) |
| Clôturer | `PATCH /seller/v2/discussions/{discussionId}` (`[{opt:replace,path:/isOpen,value:false}]`) |

En-têtes requis sur chaque appel : `Authorization: Bearer <token>` **et** `SellerId: <votre sellerId>`.
Base API : `https://api.octopia-io.net`. Identifiants à créer sur la page
*API Credentials* (`clientId`, `clientSecret`, `sellerId`).

Le mapping `salesChannel → marketplace` se règle dans `PROVIDERS[octopia].channelMap`.

### Endpoints BOMP (Fnac + Darty) — API XML

Fnac et Darty utilisent l'**API Marketplace Fnac historique, en XML** (pas du REST/JSON),
sur `https://vendeur.fnac.com/api.php/`. L'adaptateur `bomp` est en place avec :

| Action | Opération XML |
|---|---|
| S'authentifier | `POST /api.php/auth` (partner_id + shop_id + key → token de session) |
| Lister les réclamations | `POST /api.php/incidents_query` |
| Répondre / gérer une réclamation | `POST /api.php/incidents_update` |
| Messages clients | `POST /api.php/messages_query` / `messages_update` |
| Commentaires commande | `POST /api.php/client_order_comments_query` / `_update` |

Fnac et Darty partagent la **même API** ; clé distincte par boutique, `partnerId` commun.
Darty seul : back-office `seller.fnacdarty.com`.

> ⚠ **À confirmer avec la doc API** : les schémas XML détaillés (noms exacts des
> balises et attributs) ne sont **pas publics** — il faut les demander à la
> *TeamAPI* Fnac Darty (`marketplace.api@fnacdarty.com`). L'adaptateur implémente
> déjà le transport XML, l'auth, le cache de token et un parsing **tolérant** ;
> il suffira d'ajuster les chemins de balises dans `bomp.fetchClaims` une fois
> la doc (ou un exemple de réponse XML) en main.

Le proxy convertit ce XML vers le même format `claim` que les autres adaptateurs.

### Notes & avis clients — disponibilité par API

L'onglet « Notes clients » centralise les avis/notes (étoiles + commentaire). Disponibilité :

| Plateforme | Avis / notes clients via API |
|---|---|
| **Octopia (Cdiscount)** | ❌ Non exposé. L'API Octopia couvre Discussions (messages SAV), commandes, offres, produits, logistique, finances — mais **pas** les avis/notes produit. |
| **Mirakl** (Carrefour, Leroy Merlin, Boulanger, But, Cultura, Conforama, Ubaldi, Rue du Commerce, Castorama, Auchan) | ✅ Évaluations de commande exposées (note/`grade`, commentaire, client, date, réponse vendeur). |
| **Fnac / Darty (BOMP)** | ✅ `client_order_comments_query` / `_update` : récupérer **et répondre** aux commentaires/notes clients. |

Pour alimenter l'onglet Notes en réel, ajoutez dans le proxy une route `GET {API_BASE}/notes`
renvoyant un tableau d'objets `{marketplace, customer, product, ean, rating, comment, at, reply, repliedBy, visible}`,
remplie depuis les évaluations Mirakl et les `client_order_comments` Fnac/Darty (Cdiscount n'en fournira pas).

Le champ **`visible`** (booléen) doit être mappé sur le statut de modération renvoyé par l'API
(p. ex. publié/affiché → `true` ; en attente/refusé/masqué → `false`). Nom exact du champ à
confirmer dans la doc évaluations Mirakl et les schémas Fnac/Darty.
La colonne « Retrait demandé » de l'onglet Notes est, elle, un suivi interne (le retrait d'un
avis n'est pas systématiquement exposé en écriture par les API).

### Suivi de livraison (transporteurs)

Le détail d'une réclamation affiche un bloc **Suivi de livraison** (transporteur, n° de colis
copiable, statut, échéance, historique d'événements, lien direct vers le site du transporteur).
Chaque réclamation porte un champ optionnel :

```json
"tracking": { "carrier": "colissimo", "number": "6A12345678901",
  "status": "en_transit", "etaH": 24,
  "events": [ { "at": "2026-06-05T09:00:00Z", "label": "Pris en charge" } ] }
```
`status` ∈ `en_attente | en_transit | pret_retrait | livre | incident`.

**Récupération automatique** : le bouton « ↻ Rafraîchir » appelle `GET {API_BASE}/tracking?carrier=&number=`,
servi par le proxy. ⚠ On ne *scrape* pas les sites transporteurs (fragile, souvent bloqué, CGU) :
deux options propres, déjà câblées dans `proxy-exemple.js` :

- **API officielle par transporteur** — ex. Colissimo/La Poste « Suivi v2 » (`api.laposte.fr`, clé Okapi),
  Chronopost, Mondial Relay, DPD, GLS, UPS, Colis Privé, DHL (chacun nécessite un compte/clé).
- **Agrégateur multi-transporteurs** (recommandé) — une seule API pour tous (17track, AfterShip,
  TrackingMore…). Bloc commenté `trackViaAggregator` prêt à activer.

**Transporteurs préparés (API directe)** : Colissimo/La Poste, Chronopost, DPD, GLS, UPS, DHL, FedEx/TNT.
Chaque adaptateur (dans `CARRIERS` du proxy) appelle l'API officielle et normalise vers le format ci-dessus ;
les chemins de parsing marqués `TODO` sont à ajuster sur une vraie réponse. Le lien « Suivre sur le site »
fonctionne déjà sans API. Identifiants par transporteur (variables d'environnement) :

```bash
export LAPOSTE_OKAPI_KEY="..."                               # Colissimo / La Poste
export CHRONOPOST_ACCOUNT="..."  CHRONOPOST_PASSWORD="..."   # Chronopost
export DPD_USER="..."            DPD_KEY="..."               # DPD France
export GLS_USER="..."            GLS_PASSWORD="..."          # GLS
export UPS_CLIENT_ID="..."       UPS_CLIENT_SECRET="..."     # UPS (OAuth)
export DHL_API_KEY="..."                                     # DHL
export FEDEX_CLIENT_ID="..."     FEDEX_CLIENT_SECRET="..."   # FedEx (et TNT)
```

### Pièces jointes dans les réponses

Le panneau de réponse permet de joindre des fichiers (bouton « 📎 Pièce jointe »). En mode réel,
la page envoie alors la réponse en **multipart/form-data** (`body`, `status`, et un ou plusieurs
champs `attachments`) sur `POST {API_BASE}/threads/{id}/message`.

Côté proxy, il faut donc : un parseur multipart (ex. `multer`), puis transmettre les fichiers à
l'API de chaque marketplace selon ses limites :
- **Octopia** : `POST /messages` avec pièces jointes — max **3 fichiers / 4 Mo**.
- **Mirakl** : pièce jointe sur le message de thread (limite ~30 Mo).
- **Fnac/Darty (BOMP)** : pièces jointes supportées sur les messages/commentaires.

La page applique un garde-fou générique (max 5 fichiers / 10 Mo) ; ajustez-le aux limites réelles.

### Format « claim » commun (produit par le proxy, consommé par la page)

```json
{
  "id": "cdiscount:th-1042",      // "<marketplace>:<id du fil>" — sert à router la réponse
  "marketplace": "cdiscount",
  "customer": "Sophie Martin",
  "subject": "Produit reçu endommagé",
  "orderId": "CD-88213-FR",
  "product": "Cafetière Expresso X200",
  "priority": "haute",            // haute | moyenne | basse
  "status": "nouveau",            // nouveau | encours | attente | resolu
  "updatedAt": 1730000000000,     // timestamp ms
  "dueAt": 1730050000000,         // échéance SLA de réponse (timestamp ms)
  "messages": [
    { "from": "client", "at": 1729990000000, "text": "…" },
    { "from": "seller", "at": 1729995000000, "text": "…" }
  ]
}
```

---

## 4. Activer le mode réel dans la page

Dans `reclamations-marketplaces.html`, bloc `CONFIG` :

```js
USE_DEMO_DATA: false,                               // ← passer à false
API_BASE: "https://mon-site.fr/api/reclamations",   // ← URL de VOTRE proxy
OPERATORS: [ { code, label, type }, … ]             // liste affichée dans le filtre
```

La page attend de votre proxy :

- `GET  {API_BASE}/threads` → un **tableau** d'objets `claim`
- `POST {API_BASE}/threads/{id}/message` avec `{ body, status }` → `{ ok: true }`

---

## 5. Démarrer le proxy

```bash
npm install express node-fetch fast-xml-parser   # fast-xml-parser : requis pour Fnac/Darty (XML)

# Identifiants via variables d'environnement (ne jamais les committer) :

# Octopia (Cdiscount, Rakuten, Alltricks… — OAuth2) :
export OCTOPIA_CLIENT_ID="..."  OCTOPIA_CLIENT_SECRET="..."  OCTOPIA_SELLER_ID="98979"

# Mirakl (Carrefour, La Redoute, Decathlon… — clé API) :
export CARREFOUR_URL="https://..."  CARREFOUR_KEY="..."
export LAREDOUTE_URL="https://..."  LAREDOUTE_KEY="..."
export DECATHLON_URL="https://..."  DECATHLON_KEY="..."

# Fnac / Darty (BOMP — API XML vendeur.fnac.com) :
export FNAC_PARTNER_ID="..."   FNAC_SHOP_ID="..."   FNAC_KEY="..."
export DARTY_PARTNER_ID="..."  DARTY_SHOP_ID="..."  DARTY_KEY="..."

node proxy-exemple.js        # http://localhost:8787
```

Puis dans la page : `API_BASE: "http://localhost:8787/api/reclamations"`.

Une marketplace non configurée (sans URL/clé) est simplement ignorée ; si une
marketplace tombe en erreur, les autres continuent de s'afficher.

---

## 6. Intégration sur votre site / serveur

- **Page autonome** : déposez `reclamations-marketplaces.html` sur votre serveur (ex. `/sav/`).
- **Iframe** : `<iframe src="/sav/reclamations-marketplaces.html" style="width:100%;height:900px;border:0"></iframe>`.
- **Intégrée** : copiez le `<style>` + `<body>`/`<script>` dans une page existante.

> Mettez la page **derrière une authentification** (espace admin) : elle affiche des données clients.

---

## 7. Aller plus loin

- **Rafraîchissement auto** : `setInterval(load, 60000)` dans la page.
- **Notifications SLA** : alerte e-mail/Slack côté proxy quand un fil dépasse l'échéance.
- **Réponses types** : enrichir la constante `CANNED` (ou en faire une liste).
- **Nouvelles marketplaces** : si elle est Mirakl, ajoutez juste une ligne dans
  `MARKETPLACES` avec `type: 'mirakl'`. Sinon, créez un nouvel adaptateur.

Sources : doc développeur Octopia (`dev.cdiscount.com`), Marketplace Fnac Darty
(`fnacdartymarketplace.com`), doc développeur Mirakl (`developer.mirakl.com`).
