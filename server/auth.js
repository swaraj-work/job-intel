import { createHash, randomBytes, randomUUID } from 'node:crypto';
import express from 'express';
import { OAuth2Client } from 'google-auth-library';
import { db } from './db.js';

const SESSION_LIFETIME = 30 * 86400_000;
const LOGIN_LIFETIME = 10 * 60_000;
const sessionCookie = secure => secure ? '__Host-jobintel_session' : 'jobintel_session';
const loginCookie = secure => secure ? '__Host-jobintel_login' : 'jobintel_login';
const token = () => randomBytes(32).toString('base64url');
const digest = (value) => createHash('sha256').update(value).digest('base64url');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    google_sub TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
  CREATE TABLE IF NOT EXISTS login_attempts (
    state_hash TEXT PRIMARY KEY,
    browser_hash TEXT NOT NULL,
    verifier TEXT NOT NULL,
    nonce TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS login_attempts_expiry ON login_attempts(expires_at);
`);

function readCookie(req, name) {
  const value = (req.headers.cookie || '').split(';').map(part => part.trim())
    .find(part => part.startsWith(name + '='))?.slice(name.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(value || '') ? value : null;
}

export function currentSession(req, secure) {
  const value = readCookie(req, sessionCookie(secure));
  return value && db.prepare(`
    SELECT u.id, u.email, u.name, u.google_sub, s.token_hash, s.expires_at
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?
  `).get(digest(value), Date.now());
}

export function sessionActive(hash) {
  return Boolean(db.prepare('SELECT 1 FROM sessions WHERE token_hash = ? AND expires_at > ?').get(hash, Date.now()));
}

function cookieOptions(secure) {
  return { httpOnly: true, secure, sameSite: 'lax', path: '/' };
}

export function clearAccountCookies(req, res, secure) {
  const browser = readCookie(req, loginCookie(secure));
  if (browser) db.prepare('DELETE FROM login_attempts WHERE browser_hash = ?').run(digest(browser));
  res.clearCookie(loginCookie(secure), cookieOptions(secure));
  res.clearCookie(sessionCookie(secure), cookieOptions(secure));
}

export function createAuth({ origin, clientId, clientSecret, client }) {
  const routes = express.Router();
  const appUrl = new URL(origin);
  const secure = appUrl.protocol === 'https:';
  const sessionName = sessionCookie(secure);
  const loginName = loginCookie(secure);
  const cookie = cookieOptions(secure);
  const callback = new URL('/auth/google/callback', origin).href;
  const google = client || new OAuth2Client({ clientId, clientSecret, redirectUri: callback, transporterOptions: { timeout: 12_000 } });
  const enabled = Boolean(clientId && clientSecret);

  routes.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  routes.get('/google', (req, res) => {
    if (!enabled) return res.redirect('/login?error=unavailable');
    if (req.get('host') !== appUrl.host) return res.redirect(new URL('/auth/google', appUrl).href);
    const browser = readCookie(req, loginName) || token();
    const state = token();
    const verifier = token();
    const nonce = token();
    const now = Date.now();
    db.prepare('DELETE FROM login_attempts WHERE expires_at <= ?').run(now);
    const pending = db.prepare('SELECT COUNT(*) AS count FROM login_attempts').get().count;
    if (pending >= 2000) return res.status(429).send('Too many sign-in attempts. Try again shortly.');
    db.prepare('INSERT INTO login_attempts VALUES (?, ?, ?, ?, ?)')
      .run(digest(state), digest(browser), verifier, nonce, now + LOGIN_LIFETIME);
    res.cookie(loginName, browser, { ...cookie, maxAge: LOGIN_LIFETIME });
    const url = new URL(google.generateAuthUrl({
      response_type: 'code', scope: ['openid', 'email', 'profile'], state, prompt: 'select_account',
      code_challenge: digest(verifier), code_challenge_method: 'S256',
    }));
    url.searchParams.set('nonce', nonce);
    return res.redirect(url.href);
  });

  routes.get('/google/callback', async (req, res) => {
    const browser = readCookie(req, loginName);
    const { code, state, error } = req.query;
    if (!enabled || !browser || typeof state !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(state)) {
      return res.redirect('/login?error=invalid');
    }
    const attempt = db.prepare(`
      DELETE FROM login_attempts WHERE state_hash = ? AND browser_hash = ? AND expires_at > ?
      RETURNING verifier, nonce
    `).get(digest(state), digest(browser), Date.now());
    if (!attempt || error || typeof code !== 'string' || !code || code.length > 2048) {
      return res.redirect('/login?error=invalid');
    }
    try {
      const { tokens } = await google.getToken({ code, codeVerifier: attempt.verifier, redirect_uri: callback });
      if (!tokens.id_token) throw new Error('Missing ID token');
      const ticket = await google.verifyIdToken({ idToken: tokens.id_token, audience: clientId });
      const profile = ticket.getPayload();
      if (!profile?.sub || profile.nonce !== attempt.nonce || profile.email_verified !== true || !profile.email) {
        throw new Error('Invalid Google identity');
      }

      const session = token();
      const previous = currentSession(req, secure);
      const now = Date.now();
      db.exec('BEGIN');
      try {
        const user = db.prepare(`
          INSERT INTO users (id, google_sub, email, name, created_at) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (google_sub) DO UPDATE SET email = excluded.email, name = excluded.name
          RETURNING id
        `).get(randomUUID(), profile.sub, profile.email, profile.name || '', now);
        db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
        if (previous) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(previous.token_hash);
        db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(digest(session), user.id, now + SESSION_LIFETIME);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      res.clearCookie(loginName, cookie);
      res.cookie(sessionName, session, { ...cookie, maxAge: SESSION_LIFETIME });
      return res.redirect('/');
    } catch {
      return res.redirect('/login?error=failed');
    }
  });

  routes.post('/logout', (req, res) => {
    const session = currentSession(req, secure);
    if (session) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(session.token_hash);
    res.clearCookie(sessionName, cookie);
    res.json({ ok: true });
  });
  return routes;
}
