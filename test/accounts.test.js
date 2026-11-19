import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, get } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const sha256 = value => createHash('sha256').update(value).digest('base64url');

test('Google sessions and workspace data stay isolated across accounts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jobintel-accounts-'));
  process.env.DB_PATH = join(directory, 'catalog.db');
  const { createApp } = await import('../server/app.js');
  const { db, q, inWorkspace, closeDatabases } = await import('../server/db.js');
  const { initializeDiscovery, runWorkspaceTick } = await import('../server/workspaces.js');
  const { ingest } = await import('../server/scheduler.js');
  const { bus, log } = await import('../server/bus.js');
  const identities = new Map();
  let origin;
  const userProfile = {
    alice: { sub: 'google-alice', email: 'alice@example.test', name: 'Alice', email_verified: true },
    bob: { sub: 'google-bob', email: 'bob@example.test', name: 'Bob', email_verified: true },
  };
  const googleClient = {
    generateAuthUrl(options) {
      assert.deepEqual(options.scope, ['openid', 'email', 'profile']);
      assert.equal(options.code_challenge_method, 'S256');
      return 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
        state: options.state, code_challenge: options.code_challenge,
      });
    },
    async getToken({ code, codeVerifier, redirect_uri }) {
      const identity = identities.get(code);
      assert.equal(sha256(codeVerifier), identity.challenge);
      assert.equal(redirect_uri, origin + '/auth/google/callback');
      return { tokens: { id_token: code } };
    },
    async verifyIdToken({ idToken, audience }) {
      assert.equal(audience, 'test-client');
      return { getPayload: () => identities.get(idToken).profile };
    },
  };
  for (const key of ['GROQ_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY']) delete process.env[key];
  process.env.DISABLE_AGENT = '1';
  initializeDiscovery();
  ingest({ id: 'ashby-sarvam', kind: 'ashby' }, [{
    url: 'https://public.example.test/job',
    title: 'Junior Backend Engineer',
    summary: 'Build Python services in Bengaluru',
    published_at: new Date().toISOString(),
    meta: { job: { company: 'Example Startup', location: 'Bengaluru' } },
  }]);
  const server = createServer().listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const base = origin = 'http://127.0.0.1:' + server.address().port;
    server.on('request', createApp({ origin, clientId: 'test-client', clientSecret: 'test-secret', googleClient }));
    const request = (path, { cookie, body, ...options } = {}) => fetch(base + path, {
      redirect: 'manual', ...options,
      headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...options.headers },
      body: body && JSON.stringify(body),
    });
    const read = async (path, options) => {
      const response = await request(path, options);
      assert.equal(response.status, 200, response.ok ? path : path + ' ' + await response.text());
      return response.json();
    };
    const begin = async (code, profile) => {
      const start = await request('/auth/google');
      assert.equal(start.status, 302);
      assert.match(start.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/i);
      const redirect = new URL(start.headers.get('location'));
      const { nonce, state, code_challenge: challenge } = Object.fromEntries(redirect.searchParams);
      identities.set(code, { challenge, profile: { nonce, ...profile } });
      return {
        browser: start.headers.get('set-cookie').split(';')[0],
        path: '/auth/google/callback?' + new URLSearchParams({ code, state }),
      };
    };
    const login = async (code, profile) => {
      const pending = await begin(code, profile);
      const response = await request(pending.path, { cookie: pending.browser });
      assert.equal(response.headers.get('location'), '/');
      return { pending, cookie: response.headers.getSetCookie().find(value => value.startsWith('jobintel_session=')).split(';')[0] };
    };

    assert.deepEqual(await read('/api/health'), { ok: true });
    const aliasHeaders = await new Promise((resolve, reject) => {
      get(base + '/auth/google', { headers: { host: 'localhost:' + server.address().port } }, response => {
        response.resume();
        resolve(response.headers);
      }).on('error', reject);
    });
    assert.equal(aliasHeaders.location, origin + '/auth/google');
    assert.equal(aliasHeaders['set-cookie'], undefined);
    assert.equal((await request('/api/me')).status, 401);
    assert.equal((await request('/')).headers.get('location'), '/login');
    assert.match(await (await request('/login')).text(), /Continue with Google/);
    assert.equal((await request('/auth/login', { method: 'POST', body: { username: 'admin', password: 'admin' } })).status, 302);
    const rejected = await begin('untied', userProfile.alice);
    assert.equal((await request(rejected.path)).headers.get('location'), '/login?error=invalid');
    const badNonce = await begin('bad-nonce', { ...userProfile.alice, nonce: 'invalid' });
    assert.equal((await request(badNonce.path, { cookie: badNonce.browser })).headers.get('location'), '/login?error=failed');
    const unverified = await begin('unverified', { ...userProfile.alice, email_verified: false });
    assert.equal((await request(unverified.path, { cookie: unverified.browser })).headers.get('location'), '/login?error=failed');

    const aliceLogin = await login('alice', userProfile.alice);
    const alice = { cookie: aliceLogin.cookie };
    const bob = { cookie: (await login('bob', userProfile.bob)).cookie };
    assert.equal((await request(aliceLogin.pending.path, { cookie: aliceLogin.pending.browser })).headers.get('location'), '/login?error=invalid');
    assert.deepEqual(await read('/api/me', alice), { name: 'Alice', email: 'alice@example.test' });
    assert.equal((await read('/api/candidate', bob)).name, 'Bob');
    assert.equal((await request('/api/candidate', {
      ...alice, method: 'PUT', body: { name: 'Changed' }, headers: { origin: 'https://other.example.test' },
    })).status, 403);
    await read('/api/candidate', { ...alice, method: 'PUT', body: { name: 'Alice Candidate', skills: ['Python'], location: 'Bengaluru' } });
    await read('/api/candidate', { ...bob, method: 'PUT', body: { targetRoles: ['Full Stack Developer'], skills: ['React'], location: 'Mumbai' } });
    await read('/api/job-preferences', { ...alice, method: 'PUT', body: { jobHours: '1', jobView: 'saved' } });
    assert.equal((await read('/api/candidate', alice)).name, 'Alice Candidate');
    assert.deepEqual(await read('/api/job-preferences', bob), {});

    const aliceJob = (await read('/api/opportunities', alice)).openings[0];
    const bobJob = (await read('/api/opportunities', bob)).openings[0];
    assert.equal(aliceJob.url, bobJob.url);
    assert.ok(aliceJob.fit.score > bobJob.fit.score);
    await read('/api/opportunities/' + aliceJob.id, { ...alice, method: 'PATCH', body: { status: 'saved' } });
    await read('/api/opportunities/' + bobJob.id, { ...bob, method: 'PATCH', body: { status: 'applied' } });
    assert.equal((await read('/api/opportunities?hours=tracked', alice)).openings[0].status, 'saved');
    assert.equal((await read('/api/opportunities?hours=tracked', bob)).openings[0].status, 'applied');

    const aliceId = db.prepare('SELECT id FROM users WHERE google_sub = ?').get(userProfile.alice.sub).id;
    const privateCompany = inWorkspace(aliceId, () => {
      q.run("INSERT INTO sources (id, name, kind, created_by, next_run_at) VALUES ('private', 'Alice only', 'ashby', 'user', '2999-01-01')");
      ingest({ id: 'private', kind: 'ashby' }, [{
        url: 'https://private.example.test/job', title: 'Junior Backend Engineer', published_at: new Date().toISOString(),
        meta: { job: { company: 'Private Example', location: 'Bengaluru' } },
      }]);
      return Number(q.run("INSERT INTO companies (name, norm_name, notes) VALUES ('Alice Secret', 'alice secret', 'Private note')").lastInsertRowid);
    });
    assert.ok((await read('/api/sources', alice)).some(source => source.id === 'private'));
    assert.ok(!(await read('/api/sources', bob)).some(source => source.id === 'private'));
    assert.equal((await read('/api/opportunities', bob)).openings.length, 1);
    assert.equal((await read('/api/opportunities', alice)).openings.length, 2);
    assert.equal((await request('/api/leads/' + privateCompany, bob)).status, 404);
    assert.doesNotMatch(await (await request('/api/leads.csv', bob)).text(), /Alice Secret/);
    assert.match(await (await request('/api/leads.csv', alice)).text(), /Alice Secret/);
    const companyPath = '/api/leads/' + privateCompany;
    const manual = await read(companyPath + '/contacts', {
      ...alice, method: 'POST', body: { name: 'Jamie Sharma', role: 'Founder', email: 'jamie@example.test' },
    });
    assert.equal((await request('/api/contacts/' + manual.id, { ...bob, method: 'DELETE' })).status, 404);
    await read(companyPath + '/application', {
      ...alice, method: 'PATCH', body: { outreachSubject: 'Personal subject', emailDraft: 'Personal draft' },
    });
    const send = { ...alice, method: 'POST', body: { subject: 'Personal subject', body: 'Personal draft' } };
    assert.deepEqual(await read(companyPath + '/mark-sent', send), await read(companyPath + '/mark-sent', send));
    assert.equal((await read('/api/stats', alice)).dailySent, 1);
    assert.equal((await read('/api/stats', bob)).dailySent, 0);
    await read('/api/contacts/' + manual.id, { ...alice, method: 'DELETE' });
    const storedOutreach = inWorkspace(aliceId, () => q.get('SELECT contact_id, body FROM outreach_log WHERE company_id = ?', privateCompany));
    assert.equal(storedOutreach.contact_id, null);
    assert.equal(storedOutreach.body, 'Personal draft');

    const streamController = new AbortController();
    try {
      const response = await request('/api/stream', { ...bob, signal: streamController.signal });
      const reader = response.body.getReader();
      const decoded = new TextDecoder();
      assert.match(decoded.decode((await reader.read()).value), /retry:/);
      const bobId = db.prepare('SELECT id FROM users WHERE google_sub = ?').get(userProfile.bob.sub).id;
      inWorkspace(aliceId, () => log('test', 'private Alice event'));
      inWorkspace(bobId, () => bus.emit('lead', { name: 'Bob event' }));
      const received = decoded.decode((await reader.read()).value);
      assert.match(received, /Bob event/);
      assert.doesNotMatch(received, /private Alice event/);
    } finally {
      streamController.abort();
    }
    assert.doesNotMatch(JSON.stringify(await read('/api/activity', bob)), /private Alice event/);
    assert.match(JSON.stringify(await read('/api/activity', alice)), /private Alice event/);

    await Promise.all([runWorkspaceTick(), runWorkspaceTick()]);
    const alicePipeline = await read('/api/leads', alice);
    const bobPipeline = await read('/api/leads', bob);
    assert.ok(alicePipeline.leads.some(lead => lead.name === 'Private Example'));
    assert.ok(bobPipeline.leads.some(lead => lead.name === 'Example Startup'));
    assert.ok(!bobPipeline.leads.some(lead => lead.name === 'Private Example'));
    const token = alice.cookie.split('=')[1];
    assert.ok(db.prepare('SELECT 1 FROM sessions WHERE token_hash = ?').get(sha256(token)));
    assert.equal(db.prepare('SELECT 1 FROM sessions WHERE token_hash = ?').get(token), undefined);

    await read('/auth/logout', { ...alice, method: 'POST' });
    assert.equal((await request('/api/me', alice)).status, 401);
    const newLogin = await login('alice-new-email', { ...userProfile.alice, email: 'new-alice@example.test' });
    assert.equal((await read('/api/candidate', { cookie: newLogin.cookie })).name, 'Alice Candidate');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 2);
  } finally {
    await delay(10);
    await new Promise(resolve => {
      server.close(resolve);
      server.closeAllConnections();
    });
    closeDatabases();
    await rm(directory, { recursive: true, force: true });
  }
});

test('unsafe destinations and redirects are rejected before fetching private systems', async t => {
  const { publicUrl } = await import('../server/util/public-network.js');
  const { fetchText } = await import('../server/util/http.js');
  const { parseFeed } = await import('../server/sources/index.js');
  assert.throws(() => parseFeed('<!DOCTYPE rss><rss></rss>'), /document types/);
  for (const url of [
    'http://127.0.0.1/', 'http://2130706433/', 'http://169.254.169.254/',
    'http://[::ffff:127.0.0.1]/', 'http://service.internal/', 'https://user:secret@example.com/',
    'http://example.com:12345/', 'https://[::1]/',
  ]) assert.throws(() => publicUrl(url), /Only public/);
  const fetch = t.mock.method(globalThis, 'fetch', async () =>
    new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/' } }));
  await assert.rejects(fetchText('https://example.com/feed'), /Only public/);
  assert.equal(fetch.mock.callCount(), 1);
  await assert.rejects(fetchText('https://example.com/feed', { timeoutMs: 10 }), { status: 429 });
  assert.equal(fetch.mock.callCount(), 1);
});
