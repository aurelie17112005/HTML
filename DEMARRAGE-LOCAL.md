# Démarrage local — SAV authentifié et Ollama

## Pré-requis

- Node.js 20 ou plus récent ;
- Ollama installé et lancé ;
- les fichiers du projet dans un même dossier ;
- les identifiants des marketplaces que vous souhaitez tester.

## 1. Installer les dépendances

```powershell
npm ci
```

## 2. Créer la configuration locale

Sous Windows, copiez `.env.example`, renommez la copie en `.env`, puis utilisez au minimum :

```env
PORT=8787
NODE_ENV=development
ALLOWED_ORIGIN=http://localhost:8787
SESSION_SAME_SITE=lax
```

## 3. Créer les mots de passe

```powershell
npm run hash-password -- "mot-de-passe-long-pour-guillaume"
npm run hash-password -- "mot-de-passe-long-pour-sandy"
```

Placez les résultats dans `.env` :

```env
GUILLAUME_PASSWORD_HASH=scrypt$...
SANDY_PASSWORD_HASH=scrypt$...
```

Générez le secret de session :

```powershell
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Puis renseignez :

```env
AUTH_SESSION_SECRET=valeur_generee
```

## 4. Installer le modèle Ollama

Pour le modèle recommandé :

```powershell
ollama pull qwen3:8b
```

Pour une machine moins puissante :

```powershell
ollama pull qwen3:4b
```

Ajoutez dans `.env` :

```env
OLLAMA_API_BASE=http://127.0.0.1:11434
OLLAMA_MODEL=qwen3:8b
OLLAMA_TIMEOUT_MS=120000
OLLAMA_MAX_RETRIES=1
OLLAMA_MAX_OUTPUT_TOKENS=900
OLLAMA_TEMPERATURE=0
OLLAMA_KEEP_ALIVE=10m
```

Vérifiez la connexion :

```powershell
npm run check-ollama
```

## 5. Configurer les marketplaces

Renseignez seulement les fournisseurs disponibles :

- Cdiscount : `OCTOPIA_CLIENT_ID`, `OCTOPIA_CLIENT_SECRET`, `OCTOPIA_SELLER_ID` ;
- Fnac : `FNAC_PARTNER_ID`, `FNAC_SHOP_ID`, `FNAC_KEY` ;
- Darty : `DARTY_PARTNER_ID`, `DARTY_SHOP_ID`, `DARTY_KEY` ;
- Mirakl : paire `XXX_URL` et `XXX_KEY` pour chaque opérateur.

Les fournisseurs non configurés sont ignorés.

## 6. Démarrer

```powershell
npm start
```

Ouvrez ensuite :

```text
http://localhost:8787
```

La page affiche d'abord la connexion Guillaume/Sandy. Claude n'est pas un compte connectable :
il utilise Ollama pour créer uniquement des brouillons à valider.

## Vérifications utiles

Route publique du proxy :

```text
http://localhost:8787/api/reclamations/health
```

Après connexion, état d'Ollama :

```text
http://localhost:8787/api/reclamations/ai/health
```

Les diagnostics techniques restent réservés à Guillaume :

```text
http://localhost:8787/api/reclamations/diagnostic
```

## Données locales créées

```text
data/sessions/
data/ai-drafts.json
data/audit.jsonl
```

Ne publiez pas ces fichiers et ne publiez jamais `.env`.
