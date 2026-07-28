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
