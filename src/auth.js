import crypto from 'node:crypto';
import { createSession, deleteSession, purgeSessions, sessionExists } from './db.js';

const COOKIE = 'wamod_session';
const SESSION_TTL_MS = 30 * 86400000;
const MAX_FAILURES = 5;
const FAILURE_WINDOW_MS = 15 * 60000;
const PUBLIC_PATHS = new Set(['/login', '/app.css', '/common.js']);
const SAFE_METHODS = new Set(['GET', 'HEAD']);

const sha256 = (value) => crypto.createHash('sha256').update(value).digest();
const hashToken = (token) => sha256(token).toString('hex');

function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

export function createAuth(password) {
  const expected = sha256(password);
  const failures = new Map();
  purgeSessions(new Date().toISOString());

  function currentToken(req) {
    const token = readCookie(req, COOKIE);
    if (!token || !/^[\w-]{43}$/.test(token)) return null;
    return sessionExists(hashToken(token), new Date().toISOString()) ? token : null;
  }

  function setCookie(req, res, value, maxAgeSeconds) {
    const parts = [`${COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSeconds}`];
    if (req.secure) parts.push('Secure');
    res.append('Set-Cookie', parts.join('; '));
  }

  function guard(req, res, next) {
    if (!SAFE_METHODS.has(req.method) && req.get('X-Requested-With') !== 'fetch') {
      return res.status(403).json({ error: 'Requête refusée' });
    }
    if (currentToken(req)) {
      if (req.path === '/login') return res.redirect(303, '/');
      return next();
    }
    if (PUBLIC_PATHS.has(req.path) || (req.method === 'POST' && req.path === '/api/auth/login')) return next();
    if (req.path.startsWith('/api/') || !SAFE_METHODS.has(req.method)) {
      return res.status(401).json({ error: 'Non connecté' });
    }
    res.redirect(303, `/login?next=${encodeURIComponent(req.originalUrl)}`);
  }

  function login(req, res) {
    const now = Date.now();
    for (const [ip, f] of failures) if (now - f.first > FAILURE_WINDOW_MS) failures.delete(ip);

    const record = failures.get(req.ip);
    if (record && record.count >= MAX_FAILURES) {
      const wait = Math.ceil((record.first + FAILURE_WINDOW_MS - now) / 1000);
      res.set('Retry-After', String(wait));
      return res.status(429).json({ error: `Trop d'essais. Réessaie dans ${Math.ceil(wait / 60)} min.` });
    }

    const given = sha256(String(req.body?.password ?? ''));
    if (!crypto.timingSafeEqual(given, expected)) {
      const r = record || { first: now, count: 0 };
      r.count += 1;
      failures.set(req.ip, r);
      return res.status(401).json({ error: 'Mot de passe incorrect.' });
    }

    failures.delete(req.ip);
    const token = crypto.randomBytes(32).toString('base64url');
    createSession(hashToken(token), new Date(now).toISOString(), new Date(now + SESSION_TTL_MS).toISOString());
    setCookie(req, res, token, SESSION_TTL_MS / 1000);
    res.json({ ok: true });
  }

  function logout(req, res) {
    const token = currentToken(req);
    if (token) deleteSession(hashToken(token));
    setCookie(req, res, '', 0);
    res.json({ ok: true });
  }

  return { guard, login, logout };
}
