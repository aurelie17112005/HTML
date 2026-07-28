# Démarrage local — SAV authentifié et Groq

## Prérequis

- Node.js 20 ou plus récent ;
- une clé Groq ;
- les identifiants des marketplaces nécessaires.

## Installation

```powershell
npm ci
Copy-Item .env.example .env
```

Configurez les hashes Guillaume et Sandy, le secret de session, puis :

```env
GROQ_API_KEY=gsk_...
GROQ_MODEL=llama-3.3-70b-versatile
```

Vérifiez le projet :

```powershell
npm run check
npm run check-groq
```

Démarrez :

```powershell
npm start
```

Ouvrez `http://localhost:8787`.
