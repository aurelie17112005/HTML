'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { audit } = require('./audit-store');

const HUMAN_USERS = [
  {
    id: 'guillaume',
    displayName: 'Guillaume',
    role: 'admin',
    type: 'human',
    passwordHashEnv: 'GUILLAUME_PASSWORD_HASH',
  },
  {
    id: 'sandy',
    displayName: 'Sandy',
    role: 'agent',
    type: 'human',
    passwordHashEnv: 'SANDY_PASSWORD_HASH',
  },
];

const SYSTEM_USERS = [
  {
    id: 'claude',
    displayName: 'Claude',
    role: 'ai',
    type: 'system',
    canLogin: false,
  },
];

function publicUser(user) {
  return user ? {
    id: user.id,
    displayName: user.displayName,
    role: user.role,
    type: user.type,
  } : null;
}

function configuredHumanUsers() {
  return HUMAN_USERS.map(user => ({
    ...user,
    passwordHash: String(process.env[user.passwordHashEnv] || '').trim(),
  }));
}

function sameSiteValue() {
  const value = String(process.env.SESSION_SAME_SITE || 'lax').toLowerCase();
  return ['lax', 'strict', 'none'].includes(value) ? value : 'lax';
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    const key = part.slice(0, index).trim();
    const raw = part.slice(index + 1).trim();
    try { out[key] = decodeURIComponent(raw); } catch (_) { out[key] = raw; }
  }
  return out;
}

function safeEqualString(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function scryptAsync(password, salt, keyLength, options) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keyLength, options, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

async function verifyPassword(password, encodedHash) {
  const parts = String(encodedHash || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = Buffer.from(parts[4], 'base64url');
  const expected = Buffer.from(parts[5], 'base64url');
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p) || !salt.length || !expected.length) return false;

  const actual = await scryptAsync(String(password || ''), salt, expected.length, {
    N,
    r,
    p,
    maxmem: Math.max(64 * 1024 * 1024, 128 * N * r + 1024 * 1024),
  });
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function configureAuth(app) {
  const isProduction = process.env.NODE_ENV === 'production';
  if (isProduction) app.set('trust proxy', 1);

  const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
  const sessionsDir = path.join(dataDir, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });

  let secret = String(process.env.AUTH_SESSION_SECRET || '').trim();
  if (!secret) {
    if (isProduction) throw new Error('AUTH_SESSION_SECRET est obligatoire en production.');
    secret = crypto.randomBytes(48).toString('hex');
    console.warn('[auth] AUTH_SESSION_SECRET absent : secret temporaire utilisé en développement.');
  }

  const cookieName = String(process.env.SESSION_COOKIE_NAME || 'sav.sid');
  const maxAgeMs = Math.max(15 * 60 * 1000, Number(process.env.SESSION_MAX_AGE_MS || 8 * 3600 * 1000));
  const cookieOptions = {
    httpOnly: true,
    secure: isProduction || sameSiteValue() === 'none',
    sameSite: sameSiteValue(),
    maxAge: maxAgeMs,
    path: '/',
  };

  function sessionFile(sid) {
    if (!/^[a-f0-9]{64}$/.test(String(sid || ''))) return '';
    return path.join(sessionsDir, `${sid}.json`);
  }

  function signSessionId(sid) {
    return crypto.createHmac('sha256', secret).update(sid).digest('base64url');
  }

  function encodeCookie(sid) {
    return `${sid}.${signSessionId(sid)}`;
  }

  function decodeCookie(value) {
    const [sid, signature, extra] = String(value || '').split('.');
    if (extra !== undefined || !sessionFile(sid) || !signature) return '';
    return safeEqualString(signature, signSessionId(sid)) ? sid : '';
  }

  async function writeSession(sid, session) {
    const file = sessionFile(sid);
    if (!file) throw new Error('Identifiant de session invalide.');
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify(session), { encoding: 'utf8', mode: 0o600 });
    await fs.promises.rename(tmp, file);
  }

  async function readSession(sid) {
    const file = sessionFile(sid);
    if (!file) return null;
    try {
      const session = JSON.parse(await fs.promises.readFile(file, 'utf8'));
      if (!session || Number(session.expiresAt || 0) <= Date.now()) {
        await fs.promises.unlink(file).catch(() => {});
        return null;
      }
      return session;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      console.warn('[auth] session illisible :', error.message);
      return null;
    }
  }

  async function deleteSession(sid) {
    const file = sessionFile(sid);
    if (file) await fs.promises.unlink(file).catch(() => {});
  }

  function setSessionCookie(res, sid) {
    res.cookie(cookieName, encodeCookie(sid), cookieOptions);
  }

  function clearSessionCookie(res) {
    res.clearCookie(cookieName, { path: '/', sameSite: cookieOptions.sameSite, secure: cookieOptions.secure });
  }

  async function cleanupSessions() {
    try {
      const names = await fs.promises.readdir(sessionsDir);
      await Promise.all(names.filter(name => /^[a-f0-9]{64}\.json$/.test(name)).map(async name => {
        const file = path.join(sessionsDir, name);
        try {
          const row = JSON.parse(await fs.promises.readFile(file, 'utf8'));
          if (!row || Number(row.expiresAt || 0) <= Date.now()) await fs.promises.unlink(file).catch(() => {});
        } catch (_) {
          await fs.promises.unlink(file).catch(() => {});
        }
      }));
    } catch (error) {
      console.warn('[auth] nettoyage des sessions impossible :', error.message);
    }
  }
  const cleanupTimer = setInterval(cleanupSessions, 60 * 60 * 1000);
  cleanupTimer.unref?.();

  app.use(async (req, res, next) => {
    try {
      req.authSession = null;
      req.authSessionId = '';
      req.user = null;

      const rawCookie = parseCookies(req.headers.cookie)[cookieName];
      const sid = decodeCookie(rawCookie);
      if (!sid) return next();

      const session = await readSession(sid);
      if (!session) {
        clearSessionCookie(res);
        return next();
      }

      const user = configuredHumanUsers().find(item => item.id === session.userId);
      if (!user) {
        await deleteSession(sid);
        clearSessionCookie(res);
        return next();
      }

      req.authSession = session;
      req.authSessionId = sid;
      req.user = publicUser(user);

      // Session glissante, mais sans écrire sur disque à chaque requête.
      if (Date.now() - Number(session.touchedAt || 0) > 5 * 60 * 1000) {
        session.touchedAt = Date.now();
        session.expiresAt = Date.now() + maxAgeMs;
        await writeSession(sid, session);
        setSessionCookie(res, sid);
      }
      return next();
    } catch (error) {
      return next(error);
    }
  });

  function hasValidCsrf(req) {
    const supplied = String(req.headers['x-csrf-token'] || '');
    const expected = String(req.authSession?.csrfToken || '');
    return Boolean(supplied && expected && safeEqualString(supplied, expected));
  }

  const loginAttempts = new Map();
  const attemptWindowMs = 15 * 60 * 1000;
  const maxAttempts = Math.max(3, Number(process.env.AUTH_LOGIN_ATTEMPTS || 8));

  function attemptKey(req) {
    return String(req.ip || req.socket?.remoteAddress || 'unknown');
  }

  function getAttemptState(req) {
    const key = attemptKey(req);
    const now = Date.now();
    let state = loginAttempts.get(key);
    if (!state || state.resetAt <= now) {
      state = { count: 0, resetAt: now + attemptWindowMs };
      loginAttempts.set(key, state);
    }
    return { key, state };
  }

  function recordFailedAttempt(req) {
    const { key, state } = getAttemptState(req);
    state.count += 1;
    loginAttempts.set(key, state);
    return state;
  }

  app.get('/api/auth/me', (req, res) => {
    if (!req.user) return res.status(401).json({ authenticated: false });
    return res.json({
      authenticated: true,
      user: req.user,
      csrfToken: req.authSession.csrfToken,
      systemUsers: SYSTEM_USERS.map(publicUser),
    });
  });

  app.post('/api/auth/login', async (req, res) => {
    const { key, state } = getAttemptState(req);
    if (state.count >= maxAttempts) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((state.resetAt - Date.now()) / 1000))));
      return res.status(429).json({ error: 'Trop de tentatives. Réessayez dans quelques minutes.' });
    }

    const userId = String(req.body?.userId || req.body?.username || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const user = configuredHumanUsers().find(item => item.id === userId);

    if (!user || !user.passwordHash) {
      recordFailedAttempt(req);
      await audit('auth.login_failed', req, { attemptedUser: userId, reason: user ? 'not_configured' : 'unknown_user' });
      return res.status(user ? 503 : 401).json({
        error: user ? `Le mot de passe de ${user.displayName} n'est pas configuré côté serveur.` : 'Identifiants incorrects.',
      });
    }

    let ok = false;
    try { ok = await verifyPassword(password, user.passwordHash); } catch (error) { console.warn('[auth] hash invalide :', error.message); }
    if (!ok) {
      recordFailedAttempt(req);
      await audit('auth.login_failed', req, { attemptedUser: userId, reason: 'bad_password' });
      return res.status(401).json({ error: 'Identifiants incorrects.' });
    }

    loginAttempts.delete(key);
    if (req.authSessionId) await deleteSession(req.authSessionId);

    const sid = crypto.randomBytes(32).toString('hex');
    const now = Date.now();
    const session = {
      userId: user.id,
      csrfToken: crypto.randomBytes(32).toString('hex'),
      createdAt: now,
      touchedAt: now,
      expiresAt: now + maxAgeMs,
    };
    await writeSession(sid, session);
    setSessionCookie(res, sid);

    req.authSession = session;
    req.authSessionId = sid;
    req.user = publicUser(user);
    await audit('auth.login_success', req);

    return res.json({
      authenticated: true,
      user: req.user,
      csrfToken: session.csrfToken,
      systemUsers: SYSTEM_USERS.map(publicUser),
    });
  });

  app.post('/api/auth/logout', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Authentification requise.' });
    if (!hasValidCsrf(req)) return res.status(403).json({ error: 'Jeton de sécurité invalide. Rechargez la page.' });
    await audit('auth.logout', req);
    await deleteSession(req.authSessionId);
    clearSessionCookie(res);
    return res.json({ ok: true });
  });

  function requireAuth(req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'Authentification requise.' });
    return next();
  }

  function requireRole(...roles) {
    const allowed = new Set(roles);
    return (req, res, next) => {
      if (!req.user) return res.status(401).json({ error: 'Authentification requise.' });
      if (!allowed.has(req.user.role)) return res.status(403).json({ error: 'Droits insuffisants.' });
      return next();
    };
  }

  function requireCsrf(req, res, next) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (!hasValidCsrf(req)) return res.status(403).json({ error: 'Jeton de sécurité invalide. Rechargez la page.' });
    return next();
  }

  return {
    requireAuth,
    requireRole,
    requireCsrf,
    users: [...configuredHumanUsers().map(publicUser), ...SYSTEM_USERS.map(publicUser)],
  };
}

module.exports = { configureAuth, publicUser, verifyPassword };
