'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const DRAFTS_FILE = path.join(DATA_DIR, 'ai-drafts.json');
let writeQueue = Promise.resolve();

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

async function readAll() {
  ensureDataDir();
  try {
    const raw = await fs.promises.readFile(DRAFTS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function atomicWrite(rows) {
  ensureDataDir();
  const tmp = `${DRAFTS_FILE}.${process.pid}.${Date.now()}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(rows, null, 2), 'utf8');
  await fs.promises.rename(tmp, DRAFTS_FILE);
}

function withWriteLock(fn) {
  const run = writeQueue.then(fn, fn);
  writeQueue = run.catch(() => {});
  return run;
}

function publicDraft(draft) {
  if (!draft) return null;
  return {
    id: draft.id,
    claimId: draft.claimId,
    status: draft.status,
    text: draft.finalText || draft.text || '',
    originalText: draft.text || '',
    suggestedStatus: draft.suggestedStatus || 'nouveau',
    confidence: draft.confidence || 'medium',
    needsHumanInput: Boolean(draft.needsHumanInput),
    missingInformation: Array.isArray(draft.missingInformation) ? draft.missingInformation : [],
    internalNote: draft.internalNote || '',
    model: draft.model || '',
    requestedBy: draft.requestedBy || '',
    approvedBy: draft.approvedBy || '',
    rejectedBy: draft.rejectedBy || '',
    sentBy: draft.sentBy || '',
    sendingBy: draft.sendingBy || '',
    sendError: draft.sendError || '',
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
    approvedAt: draft.approvedAt || null,
    rejectedAt: draft.rejectedAt || null,
    sentAt: draft.sentAt || null,
    sendingAt: draft.sendingAt || null,
  };
}

async function createDraft(input) {
  return withWriteLock(async () => {
    const rows = await readAll();
    const now = new Date().toISOString();
    const draft = {
      id: crypto.randomUUID(),
      claimId: String(input.claimId),
      status: 'pending',
      text: String(input.text || '').trim(),
      finalText: '',
      suggestedStatus: input.suggestedStatus === 'resolu' ? 'resolu' : 'nouveau',
      confidence: ['low', 'medium', 'high'].includes(input.confidence) ? input.confidence : 'medium',
      needsHumanInput: Boolean(input.needsHumanInput),
      missingInformation: Array.isArray(input.missingInformation) ? input.missingInformation.slice(0, 10) : [],
      internalNote: String(input.internalNote || '').slice(0, 2000),
      model: String(input.model || ''),
      responseId: String(input.responseId || ''),
      requestedBy: String(input.requestedBy || ''),
      createdAt: now,
      updatedAt: now,
    };
    rows.push(draft);
    const max = Math.max(100, Number(process.env.AI_DRAFT_MAX_RECORDS || 2000));
    await atomicWrite(rows.slice(-max));
    return publicDraft(draft);
  });
}

async function getDraft(id) {
  const rows = await readAll();
  return rows.find(row => row.id === id) || null;
}

async function latestForClaim(claimId) {
  const rows = await readAll();
  const found = rows
    .filter(row => row.claimId === claimId)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
  return publicDraft(found || null);
}

async function reviewDraft(id, { action, actor, finalText }) {
  return withWriteLock(async () => {
    const rows = await readAll();
    const index = rows.findIndex(row => row.id === id);
    if (index < 0) return null;
    const draft = rows[index];
    if (draft.status === 'sent') {
      throw Object.assign(new Error('Ce brouillon a déjà été envoyé.'), { statusCode: 409 });
    }
    if (draft.status === 'sending') {
      throw Object.assign(new Error('Ce brouillon est déjà en cours d’envoi.'), { statusCode: 409 });
    }
    const now = new Date().toISOString();
    if (action === 'approve') {
      const text = String(finalText || draft.finalText || draft.text || '').trim();
      if (!text) throw Object.assign(new Error('Le texte validé est vide.'), { statusCode: 400 });
      draft.status = 'approved';
      draft.finalText = text;
      draft.approvedBy = actor;
      draft.approvedAt = now;
      draft.rejectedBy = '';
      draft.rejectedAt = null;
    } else if (action === 'reject') {
      draft.status = 'rejected';
      draft.rejectedBy = actor;
      draft.rejectedAt = now;
    } else {
      throw Object.assign(new Error('Action de validation inconnue.'), { statusCode: 400 });
    }
    draft.updatedAt = now;
    rows[index] = draft;
    await atomicWrite(rows);
    return publicDraft(draft);
  });
}

async function beginSend(id, { actor, claimId, expectedText }) {
  return withWriteLock(async () => {
    const rows = await readAll();
    const index = rows.findIndex(row => row.id === id);
    if (index < 0) return null;
    const draft = rows[index];
    if (draft.claimId !== claimId) {
      throw Object.assign(new Error('Ce brouillon ne correspond pas à cette réclamation.'), { statusCode: 409 });
    }
    if (draft.status !== 'approved') {
      throw Object.assign(new Error(
        draft.status === 'sending' ? 'Ce brouillon est déjà en cours d’envoi.' : 'Le brouillon doit être validé avant son envoi.'
      ), { statusCode: 409 });
    }
    const finalText = String(draft.finalText || draft.text || '').trim();
    if (String(expectedText || '').trim() !== finalText) {
      throw Object.assign(new Error('Le texte a changé après validation. Validez à nouveau le brouillon avant l’envoi.'), { statusCode: 409 });
    }
    const now = new Date().toISOString();
    draft.status = 'sending';
    draft.sendingBy = actor;
    draft.sendingAt = now;
    draft.sendError = '';
    draft.updatedAt = now;
    rows[index] = draft;
    await atomicWrite(rows);
    return publicDraft(draft);
  });
}

async function finishSend(id, { actor, claimId, success, error = '' }) {
  return withWriteLock(async () => {
    const rows = await readAll();
    const index = rows.findIndex(row => row.id === id);
    if (index < 0) return null;
    const draft = rows[index];
    if (draft.claimId !== claimId) {
      throw Object.assign(new Error('Ce brouillon ne correspond pas à cette réclamation.'), { statusCode: 409 });
    }
    if (draft.status !== 'sending') {
      throw Object.assign(new Error('Ce brouillon n’est pas dans un état d’envoi valide.'), { statusCode: 409 });
    }
    const now = new Date().toISOString();
    if (success) {
      draft.status = 'sent';
      draft.sentBy = actor;
      draft.sentAt = now;
      draft.sendError = '';
    } else {
      draft.status = 'approved';
      draft.sendError = String(error || '').slice(0, 500);
    }
    draft.updatedAt = now;
    rows[index] = draft;
    await atomicWrite(rows);
    return publicDraft(draft);
  });
}

module.exports = {
  createDraft,
  getDraft,
  latestForClaim,
  reviewDraft,
  beginSend,
  finishSend,
  publicDraft,
  DRAFTS_FILE,
};
