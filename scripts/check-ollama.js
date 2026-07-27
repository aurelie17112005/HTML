'use strict';

require('dotenv').config();
const { checkOllamaHealth } = require('../lib/ai-service');

(async () => {
  const health = await checkOllamaHealth();
  console.log(health.message);
  console.log(`Adresse : ${health.apiBase}`);
  console.log(`Modèle configuré : ${health.model}`);
  if (health.availableModels.length) {
    console.log(`Modèles installés : ${health.availableModels.join(', ')}`);
  }
  if (!health.ok) {
    console.error(`\nAction recommandée : ollama pull ${health.model}`);
    process.exitCode = 1;
  }
})().catch(error => {
  console.error(error.message || error);
  process.exitCode = 1;
});
