'use strict';

const fetchApi = (...args) => {
  if (typeof globalThis.fetch === 'function') return globalThis.fetch(...args);
  return import('node-fetch').then(({ default: fetch }) => fetch(...args));
};

function redactSensitiveText(value) {
  return String(value || '')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[EMAIL]')
    .replace(/\b(?:\+33|0)[1-9](?:[ .-]?\d{2}){4}\b/g, '[TÉLÉPHONE]')
    .replace(/\bFR\d{2}(?:[ ]?[A-Z0-9]){23}\b/gi, '[IBAN]')
    .replace(/\b\d{13,19}\b/g, '[NUMÉRO SENSIBLE]')
    .slice(0, 12000);
}

function compactClaim(claim) {
  const messages = Array.isArray(claim.messages) ? claim.messages.slice(-12) : [];
  return {
    marketplace: claim.marketplace || '',
    subject: redactSensitiveText(claim.subject),
    product: redactSensitiveText(claim.product),
    priority: claim.priority || '',
    status: claim.status || '',
    tracking: claim.tracking ? {
      carrier: claim.tracking.carrier || '',
      status: claim.tracking.status || '',
      etaH: claim.tracking.etaH ?? null,
      events: Array.isArray(claim.tracking.events)
        ? claim.tracking.events.slice(0, 5).map(event => ({
            at: event.at,
            label: redactSensitiveText(event.label),
          }))
        : [],
    } : null,
    conversation: messages.map(message => ({
      from: message.from === 'client' ? 'client' : 'vendeur',
      at: message.at || null,
      text: redactSensitiveText(message.text),
      attachmentNames: Array.isArray(message.attachments)
        ? message.attachments
          .map(item => String(item.name || item.filename || 'pièce jointe').slice(0, 120))
          .slice(0, 5)
        : [],
    })),
  };
}

const DRAFT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    reply: { type: 'string', description: 'Réponse prête à être relue par un agent humain.' },
    suggestedStatus: { type: 'string', enum: ['nouveau', 'resolu'] },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    needsHumanInput: { type: 'boolean' },
    missingInformation: { type: 'array', items: { type: 'string' } },
    internalNote: { type: 'string' },
  },
  required: [
    'reply',
    'suggestedStatus',
    'confidence',
    'needsHumanInput',
    'missingInformation',
    'internalNote',
  ],
};

function enforceNeutralCustomerAddress(value) {
  let text = String(value || '').trim();
  if (!text) return '';

  // Le prénom de l'agent connecté ne doit jamais être interprété comme celui du client.
  // On retire toute formule d'appel produite par le modèle puis on impose une salutation neutre.
  text = text.replace(
    /^\s*(?:(?:bonjour|bonsoir)(?:\s+(?:madame|monsieur))?(?:\s+[A-Za-zÀ-ÖØ-öø-ÿ'’\-]+){0,3}|cher(?:e)?(?:\s+client)?|madame|monsieur)\s*[,!:\-.]?\s*/i,
    ''
  ).trimStart();

  return `Bonjour,\n\n${text}`.trim();
}

function validateDraft(value) {
  if (!value || typeof value !== 'object') throw new Error('Format de brouillon IA invalide.');
  const reply = enforceNeutralCustomerAddress(value.reply);
  if (!reply) throw new Error('Claude n’a pas produit de brouillon exploitable.');
  return {
    reply,
    suggestedStatus: value.suggestedStatus === 'resolu' ? 'resolu' : 'nouveau',
    confidence: ['low', 'medium', 'high'].includes(value.confidence) ? value.confidence : 'medium',
    needsHumanInput: Boolean(value.needsHumanInput),
    missingInformation: Array.isArray(value.missingInformation)
      ? value.missingInformation.map(item => String(item || '').trim()).filter(Boolean).slice(0, 10)
      : [],
    internalNote: String(value.internalNote || '').trim().slice(0, 2000),
  };
}

function ollamaConfig() {
  const apiBase = String(process.env.OLLAMA_API_BASE || 'http://127.0.0.1:11434').replace(/\/+$/, '');
  const model = String(process.env.OLLAMA_MODEL || 'qwen3:8b').trim();
  const timeoutMs = Math.max(10000, Number(process.env.OLLAMA_TIMEOUT_MS || 120000));
  const maxRetries = Math.max(0, Math.min(3, Number(process.env.OLLAMA_MAX_RETRIES || 1)));
  const maxOutputTokens = Math.max(300, Math.min(4096, Number(process.env.OLLAMA_MAX_OUTPUT_TOKENS || 900)));
  const temperature = Math.max(0, Math.min(2, Number(process.env.OLLAMA_TEMPERATURE || 0)));
  const keepAlive = String(process.env.OLLAMA_KEEP_ALIVE || '10m').trim() || '10m';
  return { apiBase, model, timeoutMs, maxRetries, maxOutputTokens, temperature, keepAlive };
}

function ollamaUnavailableError(error, apiBase) {
  const raw = String(error?.message || error || '');
  const code = String(error?.cause?.code || error?.code || '');
  if (/ECONNREFUSED|fetch failed|ENOTFOUND|EHOSTUNREACH/i.test(`${raw} ${code}`)) {
    return Object.assign(
      new Error(`Ollama est inaccessible sur ${apiBase}. Lancez Ollama puis réessayez.`),
      { statusCode: 503, code: 'OLLAMA_UNAVAILABLE' }
    );
  }
  return error;
}

function ollamaHttpError(status, data, model) {
  const upstreamMessage = String(data?.error || data?.message || '').trim();
  if (status === 404 || /model.*not found|pull model/i.test(upstreamMessage)) {
    return Object.assign(
      new Error(`Le modèle Ollama « ${model} » n’est pas installé. Exécutez : ollama pull ${model}`),
      { statusCode: 503, upstreamStatus: status, code: 'OLLAMA_MODEL_MISSING' }
    );
  }
  return Object.assign(
    new Error(upstreamMessage || `Ollama a répondu HTTP ${status}.`),
    {
      statusCode: status >= 500 || status === 429 ? 503 : 502,
      upstreamStatus: status,
      code: 'OLLAMA_HTTP_ERROR',
    }
  );
}

async function fetchJsonWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchApi(url, { ...options, signal: controller.signal });
    const raw = await response.text();
    let data;
    try { data = raw ? JSON.parse(raw) : {}; }
    catch (_) { data = { raw }; }
    return { response, data };
  } finally {
    clearTimeout(timer);
  }
}

async function requestOllamaChat({ messages }) {
  const config = ollamaConfig();
  let lastError;

  for (let attempt = 0; attempt <= config.maxRetries; attempt += 1) {
    try {
      const { response, data } = await fetchJsonWithTimeout(
        `${config.apiBase}/api/chat`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: config.model,
            messages,
            stream: false,
            think: false,
            format: DRAFT_SCHEMA,
            keep_alive: config.keepAlive,
            options: {
              temperature: config.temperature,
              num_predict: config.maxOutputTokens,
            },
          }),
        },
        config.timeoutMs
      );

      if (response.ok) return { data, config };

      const error = ollamaHttpError(response.status, data, config.model);
      if (attempt >= config.maxRetries || ![408, 429, 500, 502, 503, 504].includes(response.status)) throw error;
      lastError = error;
    } catch (error) {
      if (error?.name === 'AbortError') {
        lastError = Object.assign(
          new Error('La génération locale a dépassé le délai autorisé. Le premier chargement du modèle peut être plus long.'),
          { statusCode: 504, code: 'OLLAMA_TIMEOUT' }
        );
      } else {
        lastError = ollamaUnavailableError(error, config.apiBase);
      }

      const retryableStatus = !lastError?.upstreamStatus
        || [408, 429, 500, 502, 503, 504].includes(lastError.upstreamStatus);
      if (
        attempt >= config.maxRetries
        || lastError?.code === 'OLLAMA_MODEL_MISSING'
        || !retryableStatus
      ) throw lastError;
    }

    await new Promise(resolve => setTimeout(resolve, Math.min(3000, 500 * (2 ** attempt))));
  }

  throw lastError || Object.assign(new Error('Génération locale impossible.'), { statusCode: 502 });
}

function normalizeModelName(value) {
  return String(value || '').trim().toLowerCase();
}

function modelIsInstalled(configuredModel, installedModels) {
  const wanted = normalizeModelName(configuredModel);
  const wantedWithoutLatest = wanted.replace(/:latest$/, '');
  return installedModels.some(item => {
    const current = normalizeModelName(item).replace(/:latest$/, '');
    return current === wantedWithoutLatest;
  });
}

async function checkOllamaHealth() {
  const config = ollamaConfig();
  try {
    const { response, data } = await fetchJsonWithTimeout(
      `${config.apiBase}/api/tags`,
      { method: 'GET', headers: { Accept: 'application/json' } },
      Math.min(config.timeoutMs, 8000)
    );
    if (!response.ok) throw ollamaHttpError(response.status, data, config.model);
    const models = (Array.isArray(data?.models) ? data.models : [])
      .map(item => String(item?.name || item?.model || '').trim())
      .filter(Boolean);
    return {
      ok: modelIsInstalled(config.model, models),
      reachable: true,
      provider: 'ollama',
      apiBase: config.apiBase,
      model: config.model,
      modelInstalled: modelIsInstalled(config.model, models),
      availableModels: models,
      message: modelIsInstalled(config.model, models)
        ? `Ollama est prêt avec le modèle ${config.model}.`
        : `Ollama fonctionne, mais le modèle ${config.model} n’est pas installé.`,
    };
  } catch (error) {
    const normalized = ollamaUnavailableError(error, config.apiBase);
    return {
      ok: false,
      reachable: false,
      provider: 'ollama',
      apiBase: config.apiBase,
      model: config.model,
      modelInstalled: false,
      availableModels: [],
      message: normalized.message,
    };
  }
}

async function generateSavDraft({ claim, requestedBy, extraInstructions = '' }) {
  const config = ollamaConfig();
  const companyRules = String(process.env.AI_SAV_INSTRUCTIONS || '').trim();
  const claimPayload = compactClaim(claim);

  const systemPrompt = [
    'Tu es Claude, assistant interne du service client 2KINGS.',
    'Tu fonctionnes localement via Ollama et tu proposes uniquement un brouillon en français.',
    'Tu ne l’envoies jamais : un agent humain doit obligatoirement le relire, le modifier si nécessaire et le valider.',
    'Reste poli, clair, bref et factuel.',
    'Commence toujours la réponse par « Bonjour, » sans nom, prénom, civilité ni identifiant client.',
    'Ne t’adresse jamais à l’agent interne connecté : son identité n’est pas celle du client.',
    'N’utilise pas « Bonjour client » ni « Cher client » ; la formule neutre attendue est simplement « Bonjour, ».',
    'N’invente jamais un remboursement, un échange, une expédition, une pièce jointe, une garantie, un délai, un geste commercial, une action logistique ou une information de suivi.',
    'Ne prétends pas avoir joint un document si aucune pièce jointe exploitable n’est indiquée.',
    'Quand une information est absente, demande-la ou indique needsHumanInput=true et liste-la dans missingInformation.',
    'Ne reproduis pas les données sensibles éventuellement présentes dans les messages.',
    'La réponse client doit se terminer par : Bien cordialement, puis Le service client 2KINGS.',
    'Réponds exclusivement avec un objet JSON conforme au schéma fourni par le serveur, sans texte avant ou après.',
    companyRules ? `Règles internes supplémentaires :\n${companyRules}` : '',
  ].filter(Boolean).join('\n');

  const userPrompt = [
    // L'identité de l'agent reste dans l'audit du serveur et n'est jamais transmise au modèle.
    // Cela évite qu'Ollama prenne Guillaume ou Sandy pour le destinataire de la réponse.
    extraInstructions
      ? `Consigne ponctuelle de l’agent : ${redactSensitiveText(extraInstructions).slice(0, 1500)}`
      : '',
    'Schéma JSON attendu :',
    JSON.stringify(DRAFT_SCHEMA),
    'Données de la réclamation :',
    JSON.stringify(claimPayload, null, 2),
  ].filter(Boolean).join('\n\n');

  const { data } = await requestOllamaChat({
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
  });

  const outputText = String(data?.message?.content || data?.response || '').trim();
  if (!outputText) {
    throw Object.assign(new Error('Claude n’a pas produit de brouillon exploitable.'), { statusCode: 502 });
  }

  let parsed;
  try { parsed = JSON.parse(outputText); }
  catch (_) {
    throw Object.assign(
      new Error('Le brouillon produit par Ollama n’est pas un JSON valide. Réessayez ou utilisez un modèle plus performant.'),
      { statusCode: 502 }
    );
  }

  return {
    ...validateDraft(parsed),
    model: `ollama:${config.model}`,
    responseId: String(data?.created_at || ''),
    requestId: '',
  };
}

module.exports = {
  generateSavDraft,
  checkOllamaHealth,
  redactSensitiveText,
  compactClaim,
  validateDraft,
  enforceNeutralCustomerAddress,
  DRAFT_SCHEMA,
};
