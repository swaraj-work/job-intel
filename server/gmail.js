import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import express from 'express';
import { OAuth2Client } from 'google-auth-library';
import { db, getSetting, setSetting, q, workspaceId, workspaceExists, WorkspaceDeletedError } from './db.js';
import { sessionActive } from './auth.js';
import { rateLimit } from './util/limits.js';

const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.compose'];
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const CONNECTION = 'gmail_connection';
const random = () => randomBytes(32).toString('base64url');
const digest = value => createHash('sha256').update(value).digest('base64url');
const encoded = value => Buffer.from(value).toString('base64');

class GmailError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const emailAddress = value => typeof value === 'string' && value.length <= 254 &&
  /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(value);

function draftMime({ to, subject, body }, from) {
  if (!emailAddress(to)) {
    throw new GmailError(400, 'Enter one valid recipient email address.');
  }
  if (typeof subject !== 'string' || !subject.trim() || Buffer.byteLength(subject) > 500 || /[\x00-\x1f\x7f]/.test(subject) ||
      typeof body !== 'string' || !body.trim() || body.length > 10_000 || body.includes('\0')) {
    throw new GmailError(400, 'Enter a subject (up to 500 bytes) and a message (up to 10,000 characters).');
  }

  // Fold UTF-8 encoded words without splitting a multi-byte character.
  const words = [];
  let chunk = '';
  for (const char of subject.trim()) {
    if (Buffer.byteLength(chunk + char) > 42) {
      words.push(chunk);
      chunk = '';
    }
    chunk += char;
  }
  words.push(chunk);
  const subjectHeader = words.map(word => '=?UTF-8?B?' + encoded(word) + '?=').join('\r\n ');
  const text = encoded(body.replace(/\r\n|[\r\n]/g, '\r\n')).match(/.{1,76}/g).join('\r\n');
  return Buffer.from([
    'From: ' + from, 'To: ' + to, 'Subject: ' + subjectHeader, 'MIME-Version: 1.0',
    'Date: ' + new Date().toUTCString().replace(/GMT$/, '+0000'),
    'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', text, '',
  ].join('\r\n')).toString('base64url');
}

function messageView(message) {
  const header = name => message.payload?.headers?.find(item => item.name.toLowerCase() === name)?.value || '';
  return {
    id: message.id, threadId: message.threadId, subject: header('subject'), from: header('from'),
    to: header('to'), date: header('date'), snippet: message.snippet || '',
  };
}

const MAX_TEXT_BYTES = 256_000;

function plainPart(part) {
  if (part?.filename || part?.headers?.some(header =>
    header.name.toLowerCase() === 'content-disposition' && /^attachment\b/i.test(header.value))) return null;
  if (part?.mimeType === 'text/plain' && (part.body?.data || part.body?.attachmentId)) return part;
  for (const child of part?.parts || []) {
    const found = plainPart(child);
    if (found) return found;
  }
  return null;
}

async function plainText(message, request) {
  const part = plainPart(message.payload);
  if (!part) return '';
  let { data, attachmentId, size } = part.body;
  if (!data && attachmentId && size > 0 && size <= MAX_TEXT_BYTES) {
    const endpoint = '/messages/' + encodeURIComponent(message.id) + '/attachments/' + encodeURIComponent(attachmentId);
    try {
      ({ data } = await request(endpoint));
    } catch (error) {
      if (error.response?.status !== 404) throw error;
    }
  }
  if (!data) return '';
  const contentType = part.headers?.find(header => header.name.toLowerCase() === 'content-type')?.value || '';
  const charset = /charset\s*=\s*"?([^";\s]+)/i.exec(contentType)?.[1] || 'utf-8';
  const bytes = Buffer.from(data.slice(0, Math.ceil(MAX_TEXT_BYTES / 3) * 4), 'base64url');
  try { return new TextDecoder(charset).decode(bytes).slice(0, 40_000); }
  catch { return bytes.toString('utf8').slice(0, 40_000); }
}

export function createGmail({ origin, clientId, clientSecret, encryptionKey, clientFactory }) {
  const router = express.Router();
  const callback = new URL('/api/gmail/callback', origin).href;
  const key = Buffer.from(encryptionKey || '', 'base64');
  const enabled = Boolean(clientId && clientSecret && key.length === 32);
  const makeClient = clientFactory || (() => new OAuth2Client({
    clientId, clientSecret, redirectUri: callback, transporterOptions: { timeout: 12_000 },
  }));
  const disconnecting = new Map();

  db.exec(`
    CREATE TABLE IF NOT EXISTS gmail_attempts (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      state_hash TEXT NOT NULL,
      session_hash TEXT NOT NULL,
      verifier TEXT NOT NULL,
      nonce TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    )
  `);

  function seal(refreshToken) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(workspaceId()));
    const data = Buffer.concat([cipher.update(refreshToken, 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), data].map(value => value.toString('base64url')).join('.');
  }

  function unseal(value) {
    try {
      const [iv, tag, data] = value.split('.').map(part => Buffer.from(part, 'base64url'));
      const cipher = createDecipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(workspaceId()));
      cipher.setAuthTag(tag);
      return Buffer.concat([cipher.update(data), cipher.final()]).toString('utf8');
    } catch {
      throw new GmailError(409, 'Reconnect Gmail to restore access.');
    }
  }

  function requireEnabled() {
    if (!enabled) throw new GmailError(503, 'Gmail is unavailable on this deployment.');
  }

  function limited(action, max, handler) {
    return async (req, res) => {
      try {
        requireEnabled();
        if (!rateLimit(`gmail:${action}:${req.account.id}`, max, 60_000)) {
          throw new GmailError(429, 'Please wait before trying again.');
        }
        await handler(req, res);
      } catch (error) {
        if (error instanceof WorkspaceDeletedError) return res.status(410).json({ error: error.message });
        if (error instanceof GmailError) return res.status(error.status).json({ error: error.message });
        if (error.response?.status === 401 || error.response?.data?.error === 'invalid_grant') {
          return res.status(409).json({ error: 'Gmail access expired or was revoked. Reconnect Gmail.' });
        }
        if (error.response?.status === 429) {
          return res.status(429).json({ error: 'Gmail is rate-limiting requests. Try again in a moment.' });
        }
        return res.status(502).json({ error: 'Gmail could not complete this request. Try again in a moment.' });
      }
    };
  }

  function connectedAccount() {
    const connection = getSetting(CONNECTION, null);
    if (!connection) throw new GmailError(409, 'Connect Gmail first.');
    return connection;
  }

  async function gmailRequest(account, connection = connectedAccount()) {
    const checkAccess = () => {
      if (!workspaceExists(account.id)) throw new WorkspaceDeletedError();
      if (!sessionActive(account.token_hash)) throw new GmailError(401, 'Your session ended. Sign in again.');
      if (getSetting(CONNECTION, null)?.token !== connection.token) {
        throw new GmailError(409, 'Your Gmail connection changed. Reload Gmail and try again.');
      }
    };
    const client = makeClient();
    client.setCredentials({ refresh_token: unseal(connection.token) });
    const { token } = await client.getAccessToken();
    if (!token) throw new GmailError(409, 'Reconnect Gmail to restore access.');
    return async (path, options) => {
      checkAccess();
      const { data } = await client.transporter.request({
        url: API + path, headers: { Authorization: 'Bearer ' + token }, retry: false, ...options,
      });
      checkAccess();
      return data;
    };
  }

  router.get('/', (req, res) => {
    const connection = enabled && getSetting(CONNECTION, null);
    res.json({ enabled, email: connection?.email || null });
  });

  router.post('/connect', limited('connect', 6, (req, res) => {
    if (disconnecting.has(req.account.id)) throw new GmailError(409, 'Gmail is disconnecting. Try again shortly.');
    const state = random();
    const verifier = random();
    const nonce = random();
    const client = makeClient();
    const url = new URL(client.generateAuthUrl({
      response_type: 'code', access_type: 'offline', prompt: 'consent', login_hint: req.account.email,
      scope: ['openid', 'email', ...SCOPES], state, code_challenge: digest(verifier),
      code_challenge_method: 'S256', redirect_uri: callback,
    }));
    url.searchParams.set('nonce', nonce);
    const now = Date.now();
    db.prepare('DELETE FROM gmail_attempts WHERE expires_at <= ?').run(now);
    db.prepare('INSERT OR REPLACE INTO gmail_attempts VALUES (?, ?, ?, ?, ?, ?)')
      .run(req.account.id, digest(state), req.account.token_hash, verifier, nonce, now + 10 * 60_000);
    res.json({ url: url.href });
  }));

  router.get('/callback', async (req, res) => {
    const { id, google_sub, token_hash } = req.account;
    const { code, state, error } = req.query;
    const redirect = (result) => res.redirect('/?gmail=' + result + '#gmail');
    if (!enabled || typeof state !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(state)) return redirect('failed');
    const stateHash = digest(state);
    const attempt = db.prepare(`SELECT verifier, nonce FROM gmail_attempts
      WHERE user_id = ? AND state_hash = ? AND session_hash = ? AND expires_at > ?`)
      .get(id, stateHash, token_hash, Date.now());
    if (!attempt) return redirect('failed');
    const consume = () => db.prepare('DELETE FROM gmail_attempts WHERE user_id = ? AND state_hash = ? AND expires_at > ?')
      .run(id, stateHash, Date.now()).changes;
    if (error || typeof code !== 'string' || !code || code.length > 2048) {
      consume();
      return redirect(error === 'access_denied' ? 'denied' : 'failed');
    }
    try {
      const client = makeClient();
      const { tokens } = await client.getToken({ code, codeVerifier: attempt.verifier, redirect_uri: callback });
      const granted = (tokens.scope || '').split(/\s+/);
      if (!tokens.id_token || !tokens.refresh_token || !SCOPES.every(scope => granted.includes(scope))) {
        consume();
        return redirect('permissions');
      }
      const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: clientId });
      const profile = ticket.getPayload();
      if (profile?.sub !== google_sub || profile.nonce !== attempt.nonce || !emailAddress(profile.email) || profile.email_verified !== true) {
        consume();
        return redirect('account');
      }
      if (!sessionActive(token_hash) || !consume()) return redirect('failed');
      setSetting(CONNECTION, { email: profile.email, token: seal(tokens.refresh_token) });
      return redirect('connected');
    } catch {
      // A concurrent callback can exchange the same code only once. Let the successful one finish.
      return redirect('failed');
    }
  });

  function prepareRevocation() {
    const pending = disconnecting.get(workspaceId());
    if (pending) return () => pending;
    const connection = getSetting(CONNECTION, null);
    return async () => {
      if (!connection) return true;
      if (!enabled) return false;
      try {
        await makeClient().revokeToken(unseal(connection.token));
        return true;
      } catch {
        return false;
      }
    };
  }

  router.delete('/', limited('disconnect', 6, async (req, res) => {
    const { id } = req.account;
    if (disconnecting.has(id)) throw new GmailError(409, 'Gmail is disconnecting.');
    const revoke = prepareRevocation();
    db.prepare('DELETE FROM gmail_attempts WHERE user_id = ?').run(id);
    q.run('DELETE FROM settings WHERE key = ?', CONNECTION);
    const pending = revoke();
    disconnecting.set(id, pending);
    try {
      res.json({ ok: true, revoked: await pending });
    } finally {
      disconnecting.delete(id);
    }
  }));

  router.get('/inbox', limited('inbox', 8, async (req, res) => {
    const request = await gmailRequest(req.account);
    const page = typeof req.query.page === 'string' ? req.query.page.slice(0, 500) : undefined;
    const { messages = [], nextPageToken } = await request('/messages', {
      params: { labelIds: 'INBOX', maxResults: 10, pageToken: page },
    });
    const headers = new URLSearchParams({ format: 'metadata' });
    for (const name of ['From', 'To', 'Subject', 'Date']) headers.append('metadataHeaders', name);
    const details = await Promise.all(messages.map(({ id }) => request('/messages/' + encodeURIComponent(id) + '?' + headers)
      .catch(error => {
        if (error.response?.status !== 404) throw error;
        return null;
      })));
    res.json({ messages: details.filter(Boolean).map(messageView), nextPage: nextPageToken || null });
  }));

  router.get('/messages/:id', limited('message', 30, async (req, res) => {
    if (!/^[a-z0-9_-]{1,120}$/i.test(req.params.id)) throw new GmailError(400, 'Invalid message ID.');
    const request = await gmailRequest(req.account);
    const message = await request('/messages/' + req.params.id, { params: { format: 'full' } }).catch(error => {
      if (error.response?.status === 404) throw new GmailError(404, 'This message is no longer available.');
      throw error;
    });
    res.json({ ...messageView(message), text: await plainText(message, request) });
  }));

  router.post('/drafts', limited('draft', 12, async (req, res) => {
    const connection = connectedAccount();
    if (!emailAddress(connection.email)) throw new GmailError(409, 'Reconnect Gmail to restore access.');
    const raw = draftMime(req.body || {}, connection.email);
    const request = await gmailRequest(req.account, connection);
    const draft = await request('/drafts', { method: 'POST', data: { message: { raw } } });
    res.status(201).json({ id: draft.id });
  }));

  return { router, prepareRevocation };
}
