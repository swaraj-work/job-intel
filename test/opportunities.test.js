import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseReaderListings, jobSources } from '../server/sources/jobs.js';
import { parseFeed } from '../server/sources/index.js';
import { matchOpening, fundingSignal } from '../server/pipeline/opportunities.js';

const source = { id: 'ashby-test', kind: 'ashby', params: {} };
const item = (title, summary = '', location = 'Bengaluru') => ({ title, summary, meta: { job: { company: 'Example', location } } });

test('engineering role and experience evidence', () => {
  for (const [title, level] of [['SDE-1', 'Early career'], ['Full Stack Developer', 'Experience unspecified'], ['AI/ML Intern', 'Internship']]) {
    assert.equal(matchOpening(item(title), source).level, level);
  }
  assert.equal(matchOpening(item('Backend developer', '0–2 years of experience'), source).level, 'Early career');
  for (const row of [item('Backend developer', 'Minimum 3 years required'), item('Backend Engineer', '3-5 years of experience'),
    item('Marketing Intern'), item('Software Development Engineer II'), item('Senior AI Engineer'), item('Backend engineer', '', 'Remote (US)')]) {
    assert.equal(matchOpening(row, source), null);
  }
  assert.equal(matchOpening({ title: 'Hiring backend interns', summary: 'Remote worldwide. Join us!' }, source).level, 'Internship');
  assert.equal(matchOpening({ title: 'Backend developer looking for opportunities', summary: 'Who is hiring in India?' }, source), null);
  assert.ok(fundingSignal('Bengaluru startup Example raises $2M seed round'));
  assert.equal(fundingSignal('Example plans to raise a seed round'), false);
});

test('Reader links own their employer and posting time across adjacent listings', () => {
  const page = 'https://www.linkedin.com/jobs/search';
  const rows = parseReaderListings([
    '[Backend Engineer](https://in.linkedin.com/jobs/view/example-918?trackingId=xyz)',
    '#### [Example](https://in.linkedin.com/company/example)', 'Bengaluru · 15 minutes ago',
    '[Sales Associate](https://in.linkedin.com/jobs/view/sales-919)', 'India · 3 hours ago',
    '[AI Engineer](https://in.linkedin.com/jobs/view/ai-920)', 'India',
  ].join('\n'), page);
  assert.equal(rows[0].url, 'https://in.linkedin.com/jobs/view/example-918');
  assert.equal(rows[0].meta.job.company, 'Example');
  assert.ok(Math.abs(Date.now() - Date.parse(rows[0].published_at) - 900000) < 1000);
  assert.equal(rows[2].published_at, null);
  assert.throws(() => parseReaderListings('# Additional Verification Required', page), /public listings/);
  assert.equal(parseFeed('<feed><entry><id>x</id><title>Post</title><updated>2025-10-02</updated><published>2025-10-01</published></entry></feed>')[0].published_at, '2025-10-01T00:00:00.000Z');
});

test('optional search connectors use provider dates and link to the original post or application', async t => {
  const previousX = process.env.X_BEARER_TOKEN;
  const previousSearch = process.env.SERPAPI_API_KEY;
  process.env.X_BEARER_TOKEN = 'fixture';
  process.env.SERPAPI_API_KEY = 'fixture';
  t.after(() => {
    if (previousX === undefined) delete process.env.X_BEARER_TOKEN; else process.env.X_BEARER_TOKEN = previousX;
    if (previousSearch === undefined) delete process.env.SERPAPI_API_KEY; else process.env.SERPAPI_API_KEY = previousSearch;
  });
  const published = '2026-01-01T09:00:00.000Z';
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (new URL(url).host === 'api.x.com') {
      assert.equal(options.headers.authorization, 'Bearer fixture');
      return Response.json({ data: [{ id: '123', text: 'Hiring SDE I in India', created_at: published }] });
    }
    return Response.json({ search_metadata: { created_at: '2026-01-01T11:00:00Z' }, jobs_results: [{
      title: 'AI Engineer Intern', company_name: 'Example', location: 'India', detected_extensions: { posted_at: '2 hours ago' },
      apply_options: [{ title: 'Original board', link: 'https://example.org/apply' }]
    }] });
  });
  const [x] = await jobSources.xjobs({ query: 'hiring' });
  assert.equal(x.published_at, published);
  assert.equal(x.url, 'https://x.com/i/web/status/123');
  const [job] = await jobSources.indexedjobs({ query: 'AI engineering intern' });
  assert.equal(job.published_at, published);
  assert.equal(job.url, 'https://example.org/apply');
  assert.equal(job.meta.job.publisher, 'Original board');
});

test('inbox includes postings by source date, keeps independent roles, and links company outreach', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'jobintel-test-'));
  process.env.DB_PATH = path.join(dir, 'test.db');
  const { db, q } = await import('../server/db.js');
  try {
    const { ingest } = await import('../server/scheduler.js');
    const { extractBatch } = await import('../server/pipeline/extract.js');
    const { upsertLead } = await import('../server/pipeline/resolve.js');
    const { api } = await import('../server/routes.js');
    q.run("INSERT INTO sources(id, name, kind) VALUES (?, 'Test careers', 'ashby'), ('news', 'Local news', 'rss')", source.id);
    const rows = [0.3, 2, 25, null, -1].map((hours, i) => ({ ...item('Junior Software Engineer'), url: 'https://example.org/job/' + i,
      published_at: hours === null ? null : new Date(Date.now() - hours * 3600000).toISOString() }));
    assert.equal(ingest(source, rows), 5);
    assert.equal(ingest(source, rows), 0);
    ingest({ id: 'news', kind: 'rss' }, [{ title: 'Example raises $2M in seed funding', url: 'https://example.org/news', published_at: rows[0].published_at }]);
    const r = q.get('SELECT id FROM raw_items WHERE url=?', rows[0].url);
    const [result] = await extractBatch([{ item: rows[0], route: 'job', source }]);
    const lead = upsertLead(result.leads[0], rows[0], source, r.id);
    const handler = api.stack.find(layer => layer.route?.path === '/opportunities').route.stack[0].handle;
    const read = async hours => {
      let response;
      await handler({ query: { hours } }, { json(data) { response = data; } });
      return response;
    };
    const hour = await read('1');
    assert.equal(hour.openings.length, 1);
    assert.equal(hour.funding.length, 1);
    assert.equal(hour.openings[0].companyId, lead.companyId);
    assert.equal((await read('24')).openings.length, 2);
    assert.equal((await read('168')).openings.length, 3);
    assert.equal((await read('undated')).openings.length, 1);
    ingest(source, [{ ...rows[3], published_at: rows[0].published_at }]);
    assert.equal((await read('1')).openings.length, 2);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('outreach templates use the selected signal and candidate details', async () => {
  const { outreachDraft } = await import('../server/pipeline/outreach.js');
  const company = { name: 'Example Labs' };
  const events = [
    { type: 'hiring', title: 'Backend internship' },
    { type: 'funding', stage: 'Seed', amount_text: '$2M' },
  ];
  const profile = {
    name: 'Candidate',
    targetRoles: ['Backend Engineer'],
    oneLinerPitch: 'I build tools for local businesses.',
    portfolioUrl: 'https://example.test/portfolio',
  };
  const contact = { name: 'Jamie Sharma' };
  const suggested = outreachDraft(company, events, profile, contact);
  assert.deepEqual(suggested, outreachDraft(company, events, profile, contact, 'hiring'));
  assert.match(suggested.body, /Hi Jamie,/);
  assert.match(suggested.body, /Backend internship/);
  assert.match(suggested.body, /I build tools for local businesses/);
  const funding = outreachDraft(company, events, profile, contact, 'funding');
  assert.match(funding.body, /Seed round \(\$2M\)/);
  assert.match(funding.body, /https:\/\/example.test\/portfolio/);
  assert.doesNotMatch(funding.body, /Backend internship/);
});
