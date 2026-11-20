import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, get } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const sha256 = value => createHash('sha256').update(value).digest('base64url');

test('Google sessions and workspace data stay isolated across accounts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jobintel-accounts-'));
  process.env.DB_PATH = join(directory, 'catalog.db');
  const { createApp } = await import('../server/app.js');
  const { db, q, inWorkspace, closeDatabases, retryWorkspaceDeletions, WorkspaceDeletedError } = await import('../server/db.js');
  const { initializeDiscovery, runWorkspaceTick } = await import('../server/workspaces.js');
  const { ingest } = await import('../server/scheduler.js');
  const { bus, log } = await import('../server/bus.js');
  const identities = new Map();
  const mailScopes = ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.compose'];
  const mailAttempts = new Map();
  const mailWrites = [];
  const mailRevocations = [];
  let mailReadGate;
  const makeGmailClient = () => {
    let refresh;
    return {
      generateAuthUrl(options) {
        assert.deepEqual(options.scope, ['openid', 'email', ...mailScopes]);
        assert.equal(options.access_type, 'offline');
        assert.equal(options.code_challenge_method, 'S256');
        mailAttempts.set(options.state, options.code_challenge);
        return 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({ state: options.state });
      },
      async getToken({ code, codeVerifier, redirect_uri }) {
        const attempt = mailAttempts.get(code);
        assert.equal(sha256(codeVerifier), attempt.challenge);
        assert.equal(redirect_uri, origin + '/api/gmail/callback');
        return { tokens: {
          id_token: code, refresh_token: 'private-refresh-' + attempt.profile.sub, scope: attempt.scopes.join(' '),
        } };
      },
      async verifyIdToken({ idToken, audience }) {
        assert.equal(audience, 'gmail-client');
        return { getPayload: () => mailAttempts.get(idToken).profile };
      },
      setCredentials(credentials) { refresh = credentials.refresh_token; },
      async getAccessToken() { return { token: refresh.replace('private-refresh-', 'access-') }; },
      async revokeToken(token) { mailRevocations.push(token); },
      transporter: {
        async request(options) {
          const url = new URL(options.url);
          const account = options.headers.Authorization.replace('Bearer access-google-', '');
          if (url.pathname.endsWith('/drafts')) {
            assert.equal(options.method, 'POST');
            assert.equal(options.retry, false);
            mailWrites.push({ account, raw: options.data.message.raw });
            return { data: { id: 'draft-' + account } };
          }
          if (url.pathname.endsWith('/messages')) {
            assert.equal(options.params.labelIds, 'INBOX');
            return { data: options.params.pageToken ? { messages: [] } : {
              messages: [{ id: 'mail-' + account }], nextPageToken: 'page-' + account,
            } };
          }
          if (url.pathname.endsWith('/mail-bob/attachments/body-bob') && account === 'bob') {
            return { data: { data: Buffer.from('Mail body for bob').toString('base64url') } };
          }
          const gate = mailReadGate;
          if (gate && url.pathname.endsWith('/mail-' + account)) {
            gate.started.resolve();
            await gate.finish.promise;
          }
          if (!url.pathname.endsWith('/mail-' + account)) throw { response: { status: 404 } };
          const detail = options.params?.format === 'full';
          return { data: {
            id: 'mail-' + account, threadId: 'thread-' + account, snippet: 'Private snippet',
            payload: {
              headers: [{ name: 'Subject', value: 'Private mail for ' + account }],
              ...(detail ? { mimeType: 'multipart/alternative', parts: [
                { mimeType: 'text/html', body: { data: Buffer.from('<script>alert(1)</script>').toString('base64url') } },
                { mimeType: 'text/plain', filename: 'secret.txt', body: { data: Buffer.from('attachment').toString('base64url') } },
                { mimeType: 'text/plain', body: account === 'bob'
                  ? { attachmentId: 'body-bob', size: 17 }
                  : { data: Buffer.from('Mail body for ' + account).toString('base64url') } },
              ] } : {}),
            },
          } };
        },
      },
    };
  };
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
    server.on('request', createApp({
      origin, clientId: 'test-client', clientSecret: 'test-secret', googleClient,
      gmail: { clientId: 'gmail-client', clientSecret: 'gmail-secret', encryptionKey: Buffer.alloc(32, 37).toString('base64'), clientFactory: makeGmailClient },
    }));
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
    const intro = await read(companyPath + '/outreach-draft?template=intro', alice);
    assert.match(intro.body, /Hi Jamie/);
    assert.match(intro.body, /Python/);
    assert.match(intro.body, /Alice Candidate/);
    assert.equal((await request(companyPath + '/outreach-draft?template=intro', bob)).status, 404);
    assert.equal((await request(companyPath + '/outreach-draft?template=funding', alice)).status, 400);
    assert.match((await read(companyPath + '/outreach-draft?template=follow-up', alice)).body, /follow up on my note/);

    const connect = async (session, profile, scopes = mailScopes) => {
      const { url } = await read('/api/gmail/connect', { ...session, method: 'POST' });
      const { state, nonce } = Object.fromEntries(new URL(url).searchParams);
      mailAttempts.set(state, { challenge: mailAttempts.get(state), profile: { ...profile, nonce }, scopes });
      return '/api/gmail/callback?' + new URLSearchParams({ code: state, state });
    };
    assert.equal((await request('/api/gmail')).status, 401);
    assert.deepEqual(await read('/api/gmail', alice), { enabled: true, email: null });
    const missingScope = await connect(alice, userProfile.alice, mailScopes.slice(0, 1));
    assert.equal((await request(missingScope, alice)).headers.get('location'), '/?gmail=permissions#gmail');
    const wrongAccount = await connect(alice, userProfile.bob);
    assert.equal((await request(wrongAccount, alice)).headers.get('location'), '/?gmail=account#gmail');
    const pending = await connect(alice, userProfile.alice);
    assert.equal((await request(pending, bob)).headers.get('location'), '/?gmail=failed#gmail');
    assert.equal((await request(pending, alice)).headers.get('location'), '/?gmail=connected#gmail');
    assert.equal((await request(pending, alice)).headers.get('location'), '/?gmail=failed#gmail');
    assert.deepEqual(await read('/api/gmail', alice), { enabled: true, email: userProfile.alice.email });
    assert.deepEqual(await read('/api/gmail', bob), { enabled: true, email: null });
    const storedMail = inWorkspace(aliceId, () => q.get("SELECT value FROM settings WHERE key = 'gmail_connection'").value);
    assert.doesNotMatch(storedMail, /private-refresh/);
    assert.equal((await request('/api/gmail/inbox', bob)).status, 409);
    assert.equal((await request(await connect(bob, userProfile.bob), bob)).headers.get('location'), '/?gmail=connected#gmail');
    const inbox = await read('/api/gmail/inbox', alice);
    assert.equal(inbox.messages[0].subject, 'Private mail for alice');
    assert.equal(inbox.nextPage, 'page-alice');
    assert.deepEqual((await read('/api/gmail/inbox?page=page-alice', alice)).messages, []);
    assert.equal((await read('/api/gmail/messages/mail-alice', alice)).text, 'Mail body for alice');
    assert.equal((await request('/api/gmail/messages/mail-alice', bob)).status, 404);
    assert.equal((await read('/api/gmail/messages/mail-bob', bob)).text, 'Mail body for bob');
    const createDraft = (overrides = {}) => ({
      ...alice, method: 'POST', body: { to: 'jamie@example.test', subject: 'Hello 👋', body: 'Line one\u2028\nLine two', ...overrides },
    });
    assert.equal((await request('/api/gmail/drafts', createDraft({ subject: 'Hi\r\nBcc: other@example.test' }))).status, 400);
    assert.equal((await request('/api/gmail/drafts', createDraft({ to: 'a@example.test,b@example.test' }))).status, 400);
    assert.equal(mailWrites.length, 0);
    const createdDraft = await request('/api/gmail/drafts', createDraft());
    assert.equal(createdDraft.status, 201);
    assert.deepEqual(await createdDraft.json(), { id: 'draft-alice' });
    assert.equal(mailWrites[0].account, 'alice');
    const mime = Buffer.from(mailWrites[0].raw, 'base64url').toString();
    assert.match(mime, /^From: alice@example.test\r\nTo: jamie@example.test\r\nSubject: =\?UTF-8\?B\?/);
    assert.equal(Buffer.from(mime.split('\r\n\r\n')[1], 'base64').toString(), 'Line one\u2028\r\nLine two');
    assert.equal((await read('/api/stats', alice)).dailySent, 0);
    const reconnect = await connect(alice, userProfile.alice);
    const gate = mailReadGate = { started: Promise.withResolvers(), finish: Promise.withResolvers() };
    const staleRead = request('/api/gmail/messages/mail-alice', alice);
    await gate.started.promise;
    assert.deepEqual(await read('/api/gmail', { ...alice, method: 'DELETE' }), { ok: true, revoked: true });
    mailReadGate = null;
    gate.finish.resolve();
    const staleResponse = await staleRead;
    assert.equal(staleResponse.status, 409);
    assert.doesNotMatch(await staleResponse.text(), /Mail body for alice/);
    assert.deepEqual(mailRevocations, ['private-refresh-google-alice']);
    assert.equal((await request(reconnect, alice)).headers.get('location'), '/?gmail=failed#gmail');
    assert.equal((await request('/api/gmail/inbox', alice)).status, 409);
    assert.equal((await read('/api/gmail', bob)).email, userProfile.bob.email);

    assert.equal((await request(companyPath + '/application', {
      ...alice, method: 'PATCH', body: { outreachSubject: 'x'.repeat(501), emailDraft: 'Replacement' },
    })).status, 400);
    assert.equal((await read(companyPath, alice)).emailDraft, 'Personal draft');
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
    const deleting = { cookie: newLogin.cookie };
    const otherDevice = { cookie: (await login('alice-other-device', { ...userProfile.alice, email: 'new-alice@example.test' })).cookie };
    const deleteRequest = session => ({ ...session, method: 'DELETE', body: { confirmation: 'DELETE' } });
    assert.equal((await request('/api/account', deleteRequest({}))).status, 401);
    assert.equal((await request('/api/account', { ...deleteRequest(deleting), body: { confirmation: 'delete' } })).status, 400);
    assert.equal((await request('/api/account', {
      ...deleteRequest(deleting), headers: { origin: 'https://other.example.test' },
    })).status, 403);

    assert.equal((await request(await connect(deleting, { ...userProfile.alice, email: 'new-alice@example.test' }), deleting))
      .headers.get('location'), '/?gmail=connected#gmail');
    const pendingMail = await connect(deleting, userProfile.alice);
    const filename = join(directory, 'catalog.db.workspaces', aliceId + '.db');
    assert.ok((await stat(filename)).isFile());
    const stream = await request('/api/stream', otherDevice);
    const streamReader = stream.body.getReader();
    assert.equal((await streamReader.read()).done, false);

    const backgroundWork = Promise.withResolvers();
    const lateWrite = assert.rejects(inWorkspace(aliceId, async () => {
      await backgroundWork.promise;
      q.run("INSERT INTO activity (entry) VALUES ('late work')");
    }), WorkspaceDeletedError);
    const deleted = await request('/api/account', deleteRequest(deleting));
    assert.equal(deleted.status, 200);
    assert.deepEqual(await deleted.json(), { workspaceCleanupPending: false, gmailRevoked: true });
    assert.match(deleted.headers.get('set-cookie'), /jobintel_session=; Path=\//);
    assert.equal((await streamReader.read()).done, true);
    backgroundWork.resolve();
    await lateWrite;
    assert.equal(db.prepare('SELECT 1 FROM users WHERE id = ?').get(aliceId), undefined);
    assert.equal(db.prepare('SELECT 1 FROM sessions WHERE user_id = ?').get(aliceId), undefined);
    assert.equal(db.prepare('SELECT 1 FROM gmail_attempts WHERE user_id = ?').get(aliceId), undefined);
    assert.equal(mailRevocations.at(-1), 'private-refresh-google-alice');
    await runWorkspaceTick();
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      await assert.rejects(stat(filename + suffix), { code: 'ENOENT' });
    }
    assert.equal((await request('/api/me', deleting)).status, 401);
    assert.equal((await request('/api/me', otherDevice)).status, 401);
    assert.equal((await request(pendingMail, deleting)).status, 401);
    assert.equal((await read('/api/me', bob)).name, 'Bob');
    assert.equal((await read('/api/gmail', bob)).email, userProfile.bob.email);
    assert.equal((await read('/api/opportunities?hours=tracked', bob)).openings[0].status, 'applied');

    const returning = { cookie: (await login('alice-returning', userProfile.alice)).cookie };
    assert.equal((await read('/api/candidate', returning)).name, 'Alice');
    assert.deepEqual((await read('/api/opportunities?hours=tracked', returning)).openings, []);
    const freshId = db.prepare('SELECT id FROM users WHERE google_sub = ?').get(userProfile.alice.sub).id;
    assert.notEqual(freshId, aliceId);

    const blockedFile = join(directory, 'catalog.db.workspaces', freshId + '.db-journal');
    await mkdir(blockedFile);
    const cleanupPending = await request('/api/account', deleteRequest(returning));
    assert.equal(cleanupPending.status, 202);
    assert.deepEqual(await cleanupPending.json(), { workspaceCleanupPending: true, gmailRevoked: true });
    assert.equal((await request('/api/me', returning)).status, 401);
    assert.ok(db.prepare('SELECT 1 FROM pending_workspace_deletions WHERE id = ?').get(freshId));
    await rm(blockedFile, { recursive: true });
    retryWorkspaceDeletions();
    assert.equal(db.prepare('SELECT 1 FROM pending_workspace_deletions WHERE id = ?').get(freshId), undefined);
    await assert.rejects(stat(join(directory, 'catalog.db.workspaces', freshId + '.db')), { code: 'ENOENT' });
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
