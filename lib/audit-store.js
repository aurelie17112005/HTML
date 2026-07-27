'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const AUDIT_FILE = path.join(DATA_DIR, 'audit.jsonl');

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function requestIp(req) {
  return String(
    req?.headers?.['x-forwarded-for']?.split(',')[0]?.trim() ||
    req?.socket?.remoteAddress ||
    ''
  ).slice(0, 120);
}

function safeDetails(details = {}) {
  const out = {};
  for (const [key, value] of Object.entries(details || {})) {
    if (value === undefined) continue;
    if (/password|secret|token|authorization|cookie|api.?key/i.test(key)) continue;
    if (typeof value === 'string') out[key] = value.slice(0, 2000);
    else out[key] = value;
  }
  return out;
}

async function audit(event, req, details = {}) {
  try {
    ensureDataDir();
    const row = {
      at: new Date().toISOString(),
      event: String(event || 'unknown'),
      actor: req?.user?.id || req?.session?.userId || 'anonymous',
      actorName: req?.user?.displayName || '',
      role: req?.user?.role || '',
      ip: requestIp(req),
      userAgent: String(req?.headers?.['user-agent'] || '').slice(0, 300),
      ...safeDetails(details),
    };
    await fs.promises.appendFile(AUDIT_FILE, JSON.stringify(row) + '\n', 'utf8');
  } catch (error) {
    console.warn('[audit] écriture impossible :', error.message);
  }
}

module.exports = { audit, AUDIT_FILE };
