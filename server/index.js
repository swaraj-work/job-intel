import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

if (fs.existsSync('.env')) process.loadEnvFile('.env');

const { default: express } = await import('express');
const { q, db } = await import('./db.js');
const { SEED_SOURCES, RETIRED_SOURCES } = await import('./sources/index.js');
const { startScheduler } = await import('./scheduler.js');
const { startProcessor } = await import('./pipeline/processor.js');
const { rebuildIntel } = await import('./pipeline/intel-store.js');
const { startAgent } = await import('./agent.js');
const { api } = await import('./routes.js');
const { log } = await import('./bus.js');
const llm = await import('./pipeline/llm.js');

// Seed the source catalogue. System sources pick up improved names and queries; enabled and cadence stay as the user set them.
for (const s of SEED_SOURCES) {
  q.run(`INSERT INTO sources(id, name, kind, category, params, cadence_min, min_cadence, max_cadence, created_by)
    VALUES(?,?,?,?,?,?,?,?, 'system')
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, params = excluded.params WHERE sources.created_by = 'system'`,
    s.id, s.name, s.kind, s.category || 'leads', JSON.stringify(s.params), s.cadence_min || 60, s.min_cadence || 15, s.max_cadence || 720);
}
for (const id of RETIRED_SOURCES) q.run(`UPDATE sources SET enabled = 0 WHERE id = ? AND created_by = 'system'`, id);

// Hosted environments listen on all interfaces by default.
const PUBLIC = Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.PUBLIC_MODE === '1' || process.env.NODE_ENV === 'production');
const AUTH_USERNAME = process.env.AUTH_USERNAME || 'admin';
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || 'admin';

const safeEq = (a, b) => {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
};

// Changing the credentials or signing secret invalidates existing sessions.
const COOKIE = 'lis';
const SESSION_DAYS = 30;
const SECRET = crypto.createHmac('sha256', process.env.SESSION_SECRET || crypto.randomBytes(32))
  .update(JSON.stringify([AUTH_USERNAME, AUTH_PASSWORD])).digest();
const sign = (v) => crypto.createHmac('sha256', SECRET).update(v).digest('base64url');
const makeToken = () => { const exp = String(Date.now() + SESSION_DAYS * 86400000); return `${exp}.${sign(exp)}`; };
function validToken(t) {
  const [exp, sig] = String(t || '').split('.');
  return Boolean(exp && sig && Number(exp) > Date.now() && safeEq(sig, sign(exp)));
}
const cookieOf = (req) => (req.headers.cookie || '').split(/;\s*/).map((c) => c.split('=')).find(([k]) => k === COOKIE)?.[1];
const authed = (req) => validToken(cookieOf(req));
const here = path.dirname(fileURLToPath(import.meta.url));

// Brute-force guard: 8 failed attempts per IP per 15 minutes.
const fails = new Map();
const tooMany = (ip) => { const f = fails.get(ip); return f && f.until > Date.now() && f.n >= 8; };
const noteFail = (ip) => { const f = fails.get(ip); fails.set(ip, f && f.until > Date.now() ? { n: f.n + 1, until: f.until } : { n: 1, until: Date.now() + 15 * 60000 }); };

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // behind Railway's proxy
app.use(express.json({ limit: '1mb' }));

app.get('/login', (req, res) => (authed(req) ? res.redirect('/') : res.sendFile(path.join(here, 'login.html'))));
app.post('/auth/login', (req, res) => {
  if (tooMany(req.ip)) return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
  const { username, password } = req.body ?? {};
  const validUsername = typeof username === 'string' && safeEq(username, AUTH_USERNAME);
  const validPassword = typeof password === 'string' && safeEq(password, AUTH_PASSWORD);
  if (!validUsername || !validPassword) {
    noteFail(req.ip);
    return res.status(401).json({ error: 'Incorrect username or password' });
  }
  fails.delete(req.ip);
  res.cookie(COOKIE, makeToken(), { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: SESSION_DAYS * 86400000, path: '/' });
  res.json({ ok: true });
});
app.post('/auth/logout', (req, res) => { res.clearCookie(COOKIE, { path: '/' }); res.json({ ok: true }); });

// Gate everything else. /api/health stays open for the platform healthcheck.
app.use((req, res, next) => {
  if (req.path === '/api/health' || authed(req)) return next();
  return req.path.startsWith('/api') ? res.status(401).json({ error: 'auth' }) : res.redirect('/login');
});
app.use('/api', api);
app.use(express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public'), { extensions: ['html'] }));

const PORT = Number(process.env.PORT) || 4300;
// Local: loopback on both IPv4 and IPv6 so "localhost" works whichever one the browser picks.
// Public: all interfaces. '::' is dual-stack on Linux (covers IPv4 too), so stop after the first success.
const HOSTS = process.env.HOST ? [process.env.HOST] : PUBLIC ? ['::', '0.0.0.0'] : ['127.0.0.1', '::1'];

function listen(host) {
  return new Promise((resolve, reject) => {
    const server = app.listen(PORT, host);
    server.once('listening', () => resolve(host));
    server.once('error', reject);
  });
}

const bound = [];
for (const host of HOSTS) {
  try {
    bound.push(await listen(host));
    if (PUBLIC && !process.env.HOST) break;
  } catch (e) {
    if (e.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} is already in use on ${host}. Another Lead Intel instance is probably running; stop it first (pkill -f server/index.js) or set PORT.`);
      process.exit(1);
    }
    if (e.code !== 'EADDRNOTAVAIL' && e.code !== 'EAFNOSUPPORT') throw e; // no IPv6 on this machine is fine
    console.warn(`Skipping ${host}: ${e.code}`);
  }
}
if (!bound.length) {
  console.error(`Could not bind port ${PORT}`);
  process.exit(1);
}

const u = llm.usage();
log('boot', `Lead Intel running on http://localhost:${PORT} (${bound.join(', ')}) · LLM: ${u.provider === 'none' ? 'rules only (set GROQ_API_KEY or GEMINI_API_KEY in .env)' : `${u.provider} ${u.model}`}`);
startScheduler();
rebuildIntel();
startProcessor();
if (process.env.DISABLE_AGENT !== '1') startAgent();

// Railway sends SIGTERM on every deploy: stop the loops and checkpoint the WAL so the volume copy is clean.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log('boot', 'Shutting down');
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); db.close(); } catch {}
    process.exit(0);
  });
}
process.on('unhandledRejection', (e) => log('error', `Unhandled: ${e?.message || e}`));
