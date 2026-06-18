# Brancher les vraies données — test en local

Objectif : faire tourner le proxy sur votre ordinateur, le remplir avec vos identifiants,
et afficher les vraies réclamations/notes dans le tableau de bord. Une fois validé en local,
on déploiera sur un serveur.

## Pré-requis
- **Node.js 18+** installé (https://nodejs.org → version LTS).
- Les fichiers suivants dans un même dossier (ex. `proxy-2kings/`) :
  `proxy-exemple.js`, `package.json`, `.env.example`.

## Étapes

1. **Créer le fichier `.env`** : dupliquez `.env.example` et renommez la copie en `.env`.
   Renseignez **uniquement** les identifiants que vous avez (laissez le reste vide) :
   - Cdiscount → `OCTOPIA_CLIENT_ID`, `OCTOPIA_CLIENT_SECRET`, `OCTOPIA_SELLER_ID`
   - Fnac/Darty → `FNAC_PARTNER_ID`/`FNAC_SHOP_ID`/`FNAC_KEY` (idem Darty)
   - Mirakl (Carrefour, Leroy Merlin…) → `XXX_URL` + `XXX_KEY`
   - Ajoutez `ALLOWED_ORIGIN=*` pour le test local.

2. **Installer + démarrer** (dans le dossier, en terminal) :
   ```
   npm install
   npm start
   ```
   Vous devez voir : `Proxy réclamations sur http://localhost:8787`

3. **Vérifier que ça répond** : ouvrez dans le navigateur
   `http://localhost:8787/api/reclamations/threads`
   → vous devez voir un tableau JSON de réclamations (ou un tableau vide `[]` si aucune en cours).
   Les sources non configurées sont ignorées sans bloquer les autres.

4. **Pointer le tableau de bord sur le proxy** : dans `index.html`, bloc `CONFIG` (vers le début
   du `<script>`), modifiez 2 lignes :
   ```js
   USE_DEMO_DATA: false,
   API_BASE: "http://localhost:8787/api/reclamations",
   ```
   Rechargez la page (Cmd/Ctrl+Shift+R). Le badge passe de « Mode démo » à « ● Connecté ».

## Ce qu'il faut me renvoyer pour finaliser

Les adaptateurs **Octopia** et **Mirakl** sont prêts ; pour **Fnac/Darty (BOMP)** et certains
champs Mirakl, je dois caler le « mapping » sur une vraie réponse. Quand le proxy tourne :

- Ouvrez `http://localhost:8787/api/reclamations/threads` et **copiez-moi le JSON** obtenu
  (anonymisez les noms si besoin), ou tout **message d'erreur** affiché dans le terminal.
- Pour Fnac/Darty, si possible un **exemple de réponse XML** d'`incidents_query` (via Postman).

À partir de ça, j'ajuste les adaptateurs pour que tout s'affiche correctement (réclamations,
puis notes et suivi).

## Dépannage rapide
- **Erreur de port** : changez `PORT` dans `.env`.
- **CORS** : vérifiez `ALLOWED_ORIGIN=*` pour le test local.
- **401/403 d'une marketplace** : identifiants invalides → vérifiez la clé/compte concerné.
- **Rien ne s'affiche** : regardez le terminal du proxy (il logue `[source] erreur` par source).
