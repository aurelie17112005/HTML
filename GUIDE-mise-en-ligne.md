# Mise en ligne sur Render

## Commandes Render

- Build command : `npm ci`
- Start command : `npm start`
- Runtime : Node.js 20 ou plus récent

## Variables indispensables

Configurez les variables d'authentification et les identifiants marketplaces, puis ajoutez :

```env
GROQ_API_KEY=gsk_...
GROQ_API_BASE=https://api.groq.com/openai/v1
GROQ_MODEL=llama-3.3-70b-versatile
GROQ_TIMEOUT_MS=45000
GROQ_MAX_RETRIES=2
GROQ_MAX_OUTPUT_TOKENS=900
GROQ_TEMPERATURE=0.1
```

Groq est appelé par le serveur Render. Il n'est plus nécessaire d'installer Ollama ni de maintenir un serveur GPU.

Après chaque modification des variables, utilisez **Save, rebuild, and deploy**.

## Vérifications

- `/api/auth/status` : état de la configuration des comptes ;
- `/api/reclamations/ai/health` : état de la clé et du modèle Groq, après connexion.

## Installation des dépendances

Ne versionnez pas et ne déployez pas le dossier `node_modules` provenant d'une archive locale. Après clonage/extraction, utilisez :

```bash
npm ci
```

Le fichier `package-lock.json` fixe les versions attendues.

### Pagination et pièces jointes

Variables optionnelles :

```env
OCTOPIA_MAX_PAGES=20
MIRAKL_MAX_PAGES=50
# Seulement si Mirakl fournit des pièces jointes depuis un CDN distinct :
MIRAKL_ATTACHMENT_ALLOWED_HOSTS=cdn.exemple.com,files.exemple.com
```
