'use strict';

require('dotenv').config();
const { checkGroqHealth } = require('../lib/ai-service');

(async () => {
  const health = await checkGroqHealth();
  console.log(health.message);
  console.log(`Adresse : ${health.apiBase}`);
  console.log(`Modèle configuré : ${health.model}`);
  if (health.availableModels.length) {
    console.log(`Modèles accessibles : ${health.availableModels.slice(0, 20).join(', ')}`);
  }
  if (!health.ok) process.exitCode = 1;
})().catch(error => {
  console.error(error.message || error);
  process.exitCode = 1;
});
