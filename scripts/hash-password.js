#!/usr/bin/env node
'use strict';

const crypto = require('crypto');

const password = process.argv.slice(2).join(' ');
if (!password) {
  console.error('Usage : npm run hash-password -- "votre mot de passe"');
  process.exit(1);
}
if (password.length < 10) {
  console.error('Choisissez un mot de passe d’au moins 10 caractères.');
  process.exit(1);
}

const N = 16384;
const r = 8;
const p = 1;
const salt = crypto.randomBytes(16);

crypto.scrypt(password, salt, 64, { N, r, p, maxmem: 64 * 1024 * 1024 }, (error, key) => {
  if (error) {
    console.error(error.message);
    process.exit(1);
  }
  const hash = `scrypt$${N}$${r}$${p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
  const renderSafe = Buffer.from(hash, 'utf8').toString('base64url');
  console.log('Hash standard (usage locale) :');
  console.log(hash);
  console.log('\nValeur Base64URL recommandée pour Render :');
  console.log(renderSafe);
});
