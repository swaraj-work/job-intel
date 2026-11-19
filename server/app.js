import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createAuth, currentSession } from './auth.js';
import { db, inWorkspace } from './db.js';
import { api } from './routes.js';
import { activateWorkspace } from './workspaces.js';
import { rateLimit } from './util/limits.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, '..', 'public');

export function appOrigin(value, port, hosted) {
  if (hosted && !value) throw new Error('APP_ORIGIN must be set to the public HTTPS origin');
  const url = new URL(value || `http://localhost:${port}`);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
      (url.protocol !== 'https:' && (hosted || url.protocol !== 'http:' || !local))) {
    throw new Error('APP_ORIGIN must be an HTTPS origin or a local HTTP origin');
  }
  return url.origin;
}

export function createApp({ origin, clientId, clientSecret, googleClient }) {
  const app = express();
  const secure = new URL(origin).protocol === 'https:';
  app.disable('x-powered-by');
  if (process.env.RAILWAY_ENVIRONMENT) app.set('trust proxy', 1);

  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' });
    if (secure) res.set('Strict-Transport-Security', 'max-age=31536000');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const requestOrigin = req.get('Origin');
      const site = req.get('Sec-Fetch-Site');
      if ((requestOrigin && requestOrigin !== origin) || (site && site !== 'same-origin' && site !== 'none')) {
        return res.status(403).json({ error: 'Request origin is not allowed' });
      }
    }
    next();
  });

  app.use(express.json({ limit: '64kb' }));
  app.get('/api/health', (req, res) => {
    db.prepare('SELECT 1').get();
    res.json({ ok: true });
  });
  for (const asset of ['theme.js', 'theme.css']) {
    app.get('/' + asset, (req, res) => res.sendFile(path.join(publicDir, asset)));
  }
  app.get('/login', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.sendFile(path.join(here, 'login.html'));
  });
  app.use('/auth', (req, res, next) => {
    if (req.path.startsWith('/google') && !rateLimit(`auth:${req.ip}`, 40, 10 * 60_000)) {
      return res.status(429).send('Too many sign-in requests. Try again shortly.');
    }
    next();
  }, createAuth({ origin, clientId, clientSecret, client: googleClient }));

  app.use((req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    const account = currentSession(req, secure);
    if (!account) {
      return req.path.startsWith('/api') ? res.status(401).json({ error: 'auth' }) : res.redirect('/login');
    }
    if (req.path.startsWith('/api') && !rateLimit(`api:${account.id}`, 240, 60_000)) {
      return res.status(429).json({ error: 'Too many requests. Try again shortly.' });
    }
    req.account = account;
    return inWorkspace(account.id, () => {
      if (req.path.startsWith('/api') || req.path === '/') activateWorkspace(account);
      next();
    });
  });

  app.use('/api', api);
  app.use(express.static(publicDir, { extensions: ['html'], cacheControl: false }));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
    if (error.type === 'entity.too.large') return res.status(413).json({ error: 'Request is too large' });
    console.error('Request failed:', error.message);
    return res.status(500).json({ error: 'Request failed' });
  });
  return app;
}
