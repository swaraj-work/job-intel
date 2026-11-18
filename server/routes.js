import { isEnterpriseName } from './pipeline/extract.js';
import { matchOpening, fundingSignal } from './pipeline/opportunities.js';
import express from 'express';
import { q, J, nowIso, getSetting, setSetting } from './db.js';
import { getConfig, saveConfig, resetConfig, DEFAULT_CONFIG } from './config.js';
import { computeScore, rescore, rescoreAll } from './pipeline/score.js';
import { enrichCompany, heuristicPitch } from './pipeline/enrich.js';
import { fetchSource, SOURCE_KINDS } from './sources/index.js';
import { runSource, runAllNow, runningSources, ingest } from './scheduler.js';
import { agentCycle, lookalike } from './agent.js';
import { stats as procStats, queueDepth } from './pipeline/processor.js';
import * as llm from './pipeline/llm.js';
import { REDDIT_SEGMENTS, REDDIT_INTENTS, REDDIT_BANDS, bandOf } from './pipeline/intel.js';
import { bus, recentActivity, log } from './bus.js';
import { sha1, fmtUsdM } from './util/text.js';
import { hostCooldowns } from './util/http.js';
import { targetPlan, contactsOf, saveContacts, suppressContact } from './pipeline/people.js';
import { findEmail, providerStatus } from './pipeline/email-finders.js';
import { companySnapshot, cachedSnapshot, findDecisionMakers, findLinkedIn, usage as sproutsUsage, SproutsError } from './pipeline/sprouts.js';
import { fetchTraction, cachedTraction, usageToday, configured as tractionConfigured, ApiError as TractionError } from './pipeline/traction.js';

export const api = express.Router();
const wrap = (fn) => (req, res) => Promise.resolve().then(() => fn(req, res)).catch((e) => res.status(400).json({ error: e.message }));
const dayAgoIso = (d = 1) => new Date(Date.now() - d * 86400000).toISOString();

// ---------- shaping ----------
function eventView(e) {
  return {
    id: e.id, type: e.type, title: e.title, summary: e.summary, url: e.url, stage: e.stage, amount: e.amount_text || fmtUsdM(e.amount_usd_m),
    amountUsdM: e.amount_usd_m, investors: J(e.investors, []), markets: J(e.markets, []), signals: J(e.signals, []), competitors: J(e.competitors, []),
    corroborations: e.corroborations, extraUrls: J(e.extra_urls, []), occurredAt: e.occurred_at, createdAt: e.created_at, source: e.source_name || e.source_id,
  };
}

function contactView(ct, primaryId) {
  return {
    id: ct.id, name: ct.name, role: ct.role, email: ct.email, emailStatus: ct.email_status, emailSource: ct.email_source, emailCheckedAt: ct.email_checked_at,
    linkedin: ct.linkedin, source: ct.source, sourceUrl: ct.source_url, evidence: ct.evidence, dnc: Boolean(ct.do_not_contact),
    primary: ct.id === primaryId, addedAt: ct.created_at,
  };
}

function companyView(c, events, checkpoint) {
  const ev = events || q.all(`SELECT e.*, s.name source_name FROM events e LEFT JOIN sources s ON s.id = e.source_id WHERE company_id = ? ORDER BY occurred_at DESC`, c.id);
  const contacts = contactsOf(c.id);
  const plan = targetPlan(c, contacts);
  const primary = contacts.find((x) => x.id === plan.primaryId);
  const funding = ev.find((e) => e.type === 'funding') || ev.find((e) => e.type === 'directory');
  const signals = [...new Set(ev.flatMap((e) => J(e.signals, [])))].slice(0, 6);
  const enr = J(c.enrichment, null);
  const techStack = J(c.tech_stack, enr?.techStack || []);
  let emailDraft = c.email_draft || c.pitch;
  let outreachSubject = c.outreach_subject;
  if (!emailDraft) {
    const fallback = heuristicPitch(c, ev, primary);
    emailDraft = fallback.body;
    if (!outreachSubject) outreachSubject = fallback.subject;
  }
  return {
    id: c.id, name: c.name, sector: c.sector, city: c.city, description: c.description, website: c.website, domain: c.domain, logo: c.logo,
    size: c.size, sellsIntl: c.sells_intl, markets: J(c.markets, []), status: c.status, feedback: c.feedback, score: c.score,
    breakdown: J(c.breakdown, []), why: c.why, pitch: emailDraft, notes: c.notes, confidence: c.confidence,
    firstSeenAt: c.first_seen_at, lastEventAt: c.last_event_at, enrichedAt: c.enriched_at,
    applicationStatus: c.application_status || 'new',
    sentAt: c.sent_at || null,
    followUpAt: c.follow_up_at || null,
    techStack,
    emailDraft,
    outreachSubject,
    roleMatch: c.role_match || null,
    enrichment: enr ? { found: enr.found, url: enr.url, title: enr.title, techStack: enr.techStack || techStack, ats: enr.ats, careersLink: enr.careersLink, social: enr.social, locales: enr.hreflangs?.length || 0 } : null,
    funding: funding ? { stage: funding.stage, amount: funding.amount_text || fmtUsdM(funding.amount_usd_m), date: funding.occurred_at, investors: J(funding.investors, []), type: funding.type } : null,
    signals,
    latest: ev[0] ? { type: ev[0].type, title: ev[0].title, url: ev[0].url, source: ev[0].source_name || ev[0].source_id, at: ev[0].occurred_at } : null,
    sources: [...new Set(ev.map((e) => e.source_name || e.source_id))],
    eventCount: ev.length,
    corroborations: ev.reduce((s, e) => s + (e.corroborations || 1), 0),
    badge: checkpoint ? (c.first_seen_at > checkpoint ? 'new' : c.last_event_at > checkpoint ? 'updated' : null) : null,
    team: plan.team ? { label: plan.team.label, n: plan.team.n, exact: plan.team.exact, source: plan.team.source, evidence: plan.team.evidence, url: plan.team.url } : null,
    target: { roles: plan.roles, reason: plan.reason },
    contact: primary ? { name: primary.name, role: primary.role, email: primary.email, hasEmail: Boolean(primary.email), linkedin: primary.linkedin } : null,
    peopleCount: contacts.filter((x) => !x.do_not_contact).length,
    openRoles: enr?.openRoles || null,
    _contacts: contacts,
    _primaryId: plan.primaryId,
  };
}

const publicView = ({ _contacts, _primaryId, ...v }) => v;

function eventsFor(ids) {
  if (!ids.length) return new Map();
  const rows = q.all(`SELECT e.*, s.name source_name FROM events e LEFT JOIN sources s ON s.id = e.source_id WHERE company_id IN (${ids.map(() => '?').join(',')}) ORDER BY occurred_at DESC`, ...ids);
  const m = new Map();
  for (const r of rows) { if (!m.has(r.company_id)) m.set(r.company_id, []); m.get(r.company_id).push(r); }
  return m;
}

// Classify raw publications directly so new listings appear even while enrichment is queued.
api.get('/opportunities', wrap((req, res) => {
  const undated = req.query.hours === 'undated';
  const hours = undated ? 168 : Number(req.query.hours || 24);
  if (![1, 24, 168].includes(hours)) return res.status(400).json({ error: 'Choose 1, 24 or 168 hours' });
  const now = Date.now();
  const timeColumn = undated ? 'r.fetched_at' : 'r.published_at';
  const rows = q.all(`SELECT r.id,r.source_id,r.url,r.title,r.summary,r.meta,r.published_at,s.kind,s.params,s.name source,
    (SELECT e.company_id FROM events e WHERE e.raw_item_id=r.id LIMIT 1) companyId
    FROM raw_items r LEFT JOIN sources s ON s.id=r.source_id
    WHERE ${undated ? 'r.published_at IS NULL AND' : ''} ${timeColumn} > ? AND ${timeColumn} <= ?
    ORDER BY ${timeColumn} DESC, r.id DESC`,
    new Date(now - hours * 3600000).toISOString(), new Date(now).toISOString());
  const openings = [], funding = [];
  for (const r of rows) {
    const meta = J(r.meta, {});
    if (meta.entity || !/^https?:\/\//i.test(r.url)) continue;
    const params = J(r.params, {});
    const item = { ...r, meta };
    const company = meta.job?.company;
    if (company && (isEnterpriseName(company) || getConfig().blocklist.some(n => n.toLowerCase() === company.toLowerCase()))) continue;
    const match = matchOpening(item, { id: r.source_id, kind: r.kind, params });
    const card = { id: r.id, title: r.title, url: r.url, published: r.published_at, approximate: !!meta.job?.approximate,
      summary: (r.summary || '').slice(0, 320), source: meta.job?.publisher || r.source || 'Original publication', companyId: r.companyId };
    if (!meta.job && ['rss', 'gnews', 'hn', 'reddit'].includes(r.kind) && fundingSignal(r.title)) funding.push(card);
    else if (match) openings.push({ ...card, ...match });
  }
  res.json({ openings, funding });
}));

// ---------- stats ----------
api.get('/stats', wrap((req, res) => {
  const cfg = getConfig();
  const one = (sql, ...p) => q.get(sql, ...p).n;
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const startOfDayIso = startOfDay.toISOString();

  res.json({
    companies: one(`SELECT COUNT(*) n FROM companies WHERE status != 'dismissed'`),
    highIntent: one(`SELECT COUNT(*) n FROM companies WHERE score >= ? AND status != 'dismissed'`, cfg.threshold),
    newToday: one('SELECT COUNT(*) n FROM companies WHERE first_seen_at > ?', dayAgoIso()),
    events24h: one('SELECT COUNT(*) n FROM events WHERE created_at > ?', dayAgoIso()),
    fundingSignals: one(`SELECT COUNT(DISTINCT company_id) n FROM events WHERE type = 'funding' AND occurred_at > ?`, dayAgoIso(30)),
    hiringSignals: one(`SELECT COUNT(DISTINCT company_id) n FROM events WHERE type = 'hiring' AND occurred_at > ?`, dayAgoIso(30)),
    dailySent: one('SELECT COUNT(*) n FROM outreach_log WHERE sent_at >= ?', startOfDayIso),
    dailyQuota: cfg.dailyQuota || 20,
    pipelineCounts: {
      new: one(`SELECT COUNT(*) n FROM companies WHERE application_status = 'new' AND status != 'dismissed'`),
      sent: one(`SELECT COUNT(*) n FROM companies WHERE application_status = 'sent'`),
      replied: one(`SELECT COUNT(*) n FROM companies WHERE application_status = 'replied'`),
      interview: one(`SELECT COUNT(*) n FROM companies WHERE application_status = 'interview'`),
      offer: one(`SELECT COUNT(*) n FROM companies WHERE application_status = 'offer'`),
      rejected: one(`SELECT COUNT(*) n FROM companies WHERE application_status = 'rejected'`),
    },
    candidate: cfg.candidate,
    items24h: one('SELECT COUNT(*) n FROM raw_items WHERE fetched_at > ?', dayAgoIso()),
    itemsTotal: one('SELECT COUNT(*) n FROM raw_items'),
    passedTotal: one(`SELECT COUNT(*) n FROM raw_items WHERE status IN ('done','processing')`),
    filteredTotal: one(`SELECT COUNT(*) n FROM raw_items WHERE status IN ('filtered','dup')`),
    sourcesActive: one('SELECT COUNT(*) n FROM sources WHERE enabled = 1'),
    sourcesError: one(`SELECT COUNT(*) n FROM sources WHERE enabled = 1 AND last_status = 'error'`),
    agentQueries: one(`SELECT COUNT(*) n FROM sources WHERE created_by = 'agent' AND enabled = 1`),
    queue: queueDepth(),
    running: runningSources(),
    sectors: q.all(`SELECT sector, COUNT(*) n, ROUND(AVG(score)) avg FROM companies WHERE status != 'dismissed' GROUP BY sector ORDER BY n DESC`),
    llm: llm.usage(),
    pipeline: procStats,
    threshold: cfg.threshold,
    cooldowns: hostCooldowns(),
    briefCheckpoint: getSetting('brief_checkpoint', null),
  });
}));

// ---------- brief (fresh since last ack) ----------
api.get('/brief', wrap((req, res) => {
  const cfg = getConfig();
  const checkpoint = getSetting('brief_checkpoint', '1970-01-01T00:00:00.000Z');
  const cands = q.all(`SELECT * FROM companies WHERE status != 'dismissed' AND last_event_at > ? AND score >= 20 ORDER BY score DESC LIMIT 400`, checkpoint);
  const N = cfg.brief.size;
  const exploitN = Math.ceil(N * (1 - cfg.brief.explorationShare));
  const picks = cands.slice(0, exploitN).map((c) => ({ c, explore: false }));
  // Exploration: best leads from sectors not yet represented, so the brief never collapses onto one segment.
  const rest = cands.slice(exploitN);
  const seen = new Set(picks.map((p) => p.c.sector));
  while (picks.length < N && rest.length) {
    let idx = rest.findIndex((c) => !seen.has(c.sector));
    if (idx < 0) idx = 0;
    const [c] = rest.splice(idx, 1);
    seen.add(c.sector);
    picks.push({ c, explore: true });
  }
  const evs = eventsFor(picks.map((p) => p.c.id));
  const intel = q.all(`SELECT * FROM intel WHERE created_at > ? AND category != 'voice' ORDER BY importance DESC, published_at DESC LIMIT 8`, checkpoint);
  const redditHot = q.get(`SELECT COUNT(*) n FROM intel WHERE category = 'voice' AND status = 'new' AND score >= 80 AND created_at > ?`, checkpoint).n;
  res.json({
    checkpoint,
    totalNew: cands.filter((c) => c.first_seen_at > checkpoint).length,
    totalUpdated: cands.filter((c) => c.first_seen_at <= checkpoint).length,
    leads: picks.map(({ c, explore }) => ({ ...publicView(companyView(c, evs.get(c.id) || [], checkpoint)), explore })),
    intel,
    redditHot,
  });
}));

api.post('/brief/ack', wrap((req, res) => {
  const prev = getSetting('brief_checkpoint', null);
  setSetting('brief_prev_checkpoint', prev);
  setSetting('brief_checkpoint', nowIso());
  res.json({ ok: true });
}));

api.post('/brief/undo', wrap((req, res) => {
  setSetting('brief_checkpoint', getSetting('brief_prev_checkpoint', null) || '1970-01-01T00:00:00.000Z');
  res.json({ ok: true });
}));

// ---------- leads ----------
function leadQuery(qs) {
  const where = [];
  const p = [];
  if (qs.status && qs.status !== 'all') { where.push('c.status = ?'); p.push(qs.status); } else if (qs.status !== 'all') where.push(`c.status != 'dismissed'`);
  if (qs.appStatus && qs.appStatus !== 'all') { where.push('c.application_status = ?'); p.push(qs.appStatus); }
  if (qs.q) { where.push('(c.name LIKE ? OR c.description LIKE ? OR c.why LIKE ? OR c.city LIKE ?)'); const l = `%${qs.q}%`; p.push(l, l, l, l); }
  if (qs.sector) { where.push('c.sector = ?'); p.push(qs.sector); }
  if (qs.minScore) { where.push('c.score >= ?'); p.push(Number(qs.minScore)); }
  if (qs.stage) { where.push('EXISTS (SELECT 1 FROM events e WHERE e.company_id = c.id AND e.stage = ?)'); p.push(qs.stage); }
  if (qs.source) { where.push('EXISTS (SELECT 1 FROM events e WHERE e.company_id = c.id AND e.source_id = ?)'); p.push(qs.source); }
  if (qs.type) { where.push('EXISTS (SELECT 1 FROM events e WHERE e.company_id = c.id AND e.type = ?)'); p.push(qs.type); }
  if (qs.intl === '1') where.push(`(c.sells_intl IN ('yes','likely') OR c.markets != '[]')`);
  if (qs.days) { where.push('c.last_event_at > ?'); p.push(dayAgoIso(Number(qs.days))); }
  if (qs.hideEnterprise === '1') where.push(`c.size != 'enterprise'`);
  const order = { recent: 'c.last_event_at DESC', new: 'c.first_seen_at DESC', name: 'c.name COLLATE NOCASE' }[qs.sort] || 'c.score DESC, c.last_event_at DESC';
  return { sql: `FROM companies c ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`, p, order };
}

api.get('/leads', wrap((req, res) => {
  const { sql, p, order } = leadQuery(req.query);
  const limit = Math.min(200, Number(req.query.limit) || 50);
  const offset = Number(req.query.offset) || 0;
  const total = q.get(`SELECT COUNT(*) n ${sql}`, ...p).n;
  const rows = q.all(`SELECT c.* ${sql} ORDER BY ${order} LIMIT ? OFFSET ?`, ...p, limit, offset);
  const evs = eventsFor(rows.map((r) => r.id));
  const checkpoint = getSetting('brief_checkpoint', null);
  res.json({ total, leads: rows.map((c) => publicView(companyView(c, evs.get(c.id) || [], checkpoint))) });
}));

api.get('/leads.csv', wrap((req, res) => {
  const { sql, p, order } = leadQuery(req.query);
  const rows = q.all(`SELECT c.* ${sql} ORDER BY ${order} LIMIT 5000`, ...p);
  const evs = eventsFor(rows.map((r) => r.id));
  const cols = ['name', 'score', 'application_status', 'sector', 'city', 'website', 'tech_stack', 'stage', 'amount', 'funding_date', 'team_size', 'contact_name', 'contact_role', 'contact_email', 'email_status', 'reach_out_to', 'why', 'cold_email_subject', 'cold_email_draft', 'source_url', 'sent_at'];
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [cols.join(',')];
  for (const c of rows) {
    const v = companyView(c, evs.get(c.id) || []);
    const pc = v._contacts.find((x) => x.id === v._primaryId);
    lines.push([
      v.name, v.score, v.applicationStatus, v.sector, v.city, v.website,
      (v.techStack || []).join('; '),
      v.funding?.stage, v.funding?.amount, v.funding?.date?.slice(0, 10),
      v.team ? `${v.team.label}${v.team.exact ? '' : ' (est.)'}` : '',
      pc?.name, pc?.role, pc?.email, pc?.email_status,
      v.target.roles.join(' / '),
      v.why, v.outreachSubject, v.emailDraft,
      v.latest?.url, v.sentAt ? v.sentAt.slice(0, 10) : ''
    ].map(esc).join(','));
  }
  res.setHeader('content-type', 'text/csv; charset=utf-8');
  res.setHeader('content-disposition', `attachment; filename="jobintel-pipeline-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(lines.join('\n'));
}));

api.get('/leads/:id', wrap((req, res) => {
  const c = q.get('SELECT * FROM companies WHERE id = ?', req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  const events = q.all(`SELECT e.*, s.name source_name FROM events e LEFT JOIN sources s ON s.id = e.source_id WHERE company_id = ? ORDER BY occurred_at DESC`, c.id);
  if (!c.seen_at) q.run('UPDATE companies SET seen_at = ? WHERE id = ?', nowIso(), c.id);
  const v = companyView(c, events);
  const enr = J(c.enrichment, null);
  res.json({
    ...publicView(v),
    events: events.map(eventView),
    contacts: v._contacts.map((x) => contactView(x, v._primaryId)),
    inboxes: enr?.emails || [],
    emailProviders: providerStatus(),
    sprouts: sproutsUsage(),
  });
}));

// ---------- contacts ----------
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

api.post('/leads/:id/contacts', wrap((req, res) => {
  const c = q.get('SELECT * FROM companies WHERE id = ?', req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  const { name, role, email } = req.body || {};
  if (!name || String(name).trim().split(/\s+/).length < 2) throw new Error('Full name (first and last) is required');
  if (email && !EMAIL_RE.test(email)) throw new Error('That email address does not look valid');
  const added = saveContacts(c.id, [{ name, role, evidence: 'Added manually' }], { source: 'manual', confidence: 1 });
  if (!added) throw new Error('This person is already listed (or was removed and suppressed)');
  const ct = q.get('SELECT id FROM contacts WHERE company_id = ? ORDER BY id DESC LIMIT 1', c.id);
  if (email) q.run(`UPDATE contacts SET email = ?, email_status = 'manual', email_source = 'manual', email_checked_at = ? WHERE id = ?`, email.trim(), nowIso(), ct.id);
  res.json({ ok: true, id: ct.id });
}));

api.patch('/contacts/:id', wrap((req, res) => {
  const ct = q.get('SELECT * FROM contacts WHERE id = ?', req.params.id);
  if (!ct) return res.status(404).json({ error: 'Not found' });
  const { dnc, role } = req.body || {};
  if (typeof dnc === 'boolean') q.run('UPDATE contacts SET do_not_contact = ?, updated_at = ? WHERE id = ?', dnc ? 1 : 0, nowIso(), ct.id);
  if (typeof role === 'string') q.run('UPDATE contacts SET role = ?, updated_at = ? WHERE id = ?', role.trim().slice(0, 80) || null, nowIso(), ct.id);
  res.json({ ok: true });
}));

// Erasure: delete the row and suppress the person so research never re-adds them.
api.delete('/contacts/:id', wrap((req, res) => {
  const ct = q.get('SELECT * FROM contacts WHERE id = ?', req.params.id);
  if (!ct) return res.status(404).json({ error: 'Not found' });
  suppressContact(ct.company_id, ct.norm_name);
  q.run('DELETE FROM contacts WHERE id = ?', ct.id);
  log('people', `Removed and suppressed a contact at company #${ct.company_id}`);
  res.json({ ok: true });
}));

api.post('/contacts/:id/find-email', wrap(async (req, res) => {
  res.json(await findEmail(Number(req.params.id)));
}));

api.patch('/leads/:id', wrap((req, res) => {
  const c = q.get('SELECT * FROM companies WHERE id = ?', req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  const { status, appStatus, notes, feedback } = req.body || {};
  if (status && ['new', 'reviewed', 'contacted', 'qualified', 'dismissed'].includes(status)) q.run('UPDATE companies SET status = ?, updated_at = ? WHERE id = ?', status, nowIso(), c.id);
  if (appStatus && ['new', 'sent', 'replied', 'interview', 'offer', 'rejected', 'archived'].includes(appStatus)) {
    q.run('UPDATE companies SET application_status = ?, updated_at = ? WHERE id = ?', appStatus, nowIso(), c.id);
  }
  if (typeof notes === 'string') q.run('UPDATE companies SET notes = ?, updated_at = ? WHERE id = ?', notes.slice(0, 5000), nowIso(), c.id);
  if ([-1, 0, 1].includes(feedback) && feedback !== c.feedback) {
    q.run('UPDATE companies SET feedback = ?, updated_at = ? WHERE id = ?', feedback, nowIso(), c.id);
    learnFromFeedback(c, c.feedback, feedback);
    if (feedback === -1 && c.status !== 'dismissed') q.run(`UPDATE companies SET status = 'dismissed' WHERE id = ?`, c.id);
  }
  rescore(c.id);
  res.json({ ok: true });
}));

// Quick 1-click action: Mark cold email sent to this company's founder/CTO
api.post('/leads/:id/mark-sent', wrap((req, res) => {
  const c = q.get('SELECT * FROM companies WHERE id = ?', req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  const contacts = contactsOf(c.id);
  const plan = targetPlan(c, contacts);
  const primary = contacts.find((x) => x.id === plan.primaryId) || contacts[0];
  const subject = req.body?.subject || c.outreach_subject;
  const body = req.body?.body || c.email_draft || c.pitch;
  const now = nowIso();

  q.run(`UPDATE companies SET application_status = 'sent', sent_at = ?, updated_at = ? WHERE id = ?`, now, now, c.id);
  q.run(`INSERT INTO outreach_log(company_id, contact_id, status, subject, body, recipient_email, sent_at) VALUES(?,?,?,?,?,?,?)`,
    c.id, primary?.id || null, 'sent', subject, body, primary?.email || null, now);

  log('outreach', `Cold email marked sent to ${c.name} (${primary?.name || 'Founder'})`);
  bus.emit('outreach', { id: c.id, name: c.name, status: 'sent' });
  res.json({ ok: true, sentAt: now });
}));

api.patch('/leads/:id/application', wrap((req, res) => {
  const c = q.get('SELECT * FROM companies WHERE id = ?', req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  const { status, notes, emailDraft, outreachSubject, followUpAt } = req.body || {};
  if (status && ['new', 'sent', 'replied', 'interview', 'offer', 'rejected', 'archived'].includes(status)) {
    q.run(`UPDATE companies SET application_status = ?, updated_at = ? WHERE id = ?`, status, nowIso(), c.id);
    if (status === 'sent') {
      q.run(`UPDATE companies SET sent_at = COALESCE(sent_at, ?) WHERE id = ?`, nowIso(), c.id);
    }
  }
  if (typeof notes === 'string') q.run(`UPDATE companies SET notes = ?, updated_at = ? WHERE id = ?`, notes, nowIso(), c.id);
  if (typeof emailDraft === 'string') q.run(`UPDATE companies SET email_draft = ?, updated_at = ? WHERE id = ?`, emailDraft, nowIso(), c.id);
  if (typeof outreachSubject === 'string') q.run(`UPDATE companies SET outreach_subject = ?, updated_at = ? WHERE id = ?`, outreachSubject, nowIso(), c.id);
  if (typeof followUpAt === 'string') q.run(`UPDATE companies SET follow_up_at = ?, updated_at = ? WHERE id = ?`, followUpAt, nowIso(), c.id);
  res.json({ ok: true });
}));

api.get('/candidate', wrap((req, res) => {
  res.json(getConfig().candidate || {});
}));

api.put('/candidate', wrap((req, res) => {
  const cfg = getConfig();
  const next = { ...cfg, candidate: { ...cfg.candidate, ...(req.body || {}) } };
  saveConfig(next);
  res.json({ ok: true, candidate: next.candidate });
}));

// Bounded learning: feedback nudges sector weight (±25% max) and source quality counters.
function learnFromFeedback(c, prev, next) {
  const learned = getSetting('learned', { sector: {} });
  learned.sector ||= {};
  const delta = (next - prev) * 0.04;
  learned.sector[c.sector] = Math.max(-0.25, Math.min(0.25, (learned.sector[c.sector] || 0) + delta));
  setSetting('learned', learned);
  const srcs = q.all('SELECT DISTINCT source_id FROM events WHERE company_id = ?', c.id).map((r) => r.source_id);
  for (const s of srcs) {
    if (prev === 1) q.run('UPDATE sources SET approved = MAX(0, approved - 1) WHERE id = ?', s);
    if (prev === -1) q.run('UPDATE sources SET rejected = MAX(0, rejected - 1) WHERE id = ?', s);
    if (next === 1) q.run('UPDATE sources SET approved = approved + 1 WHERE id = ?', s);
    if (next === -1) q.run('UPDATE sources SET rejected = rejected + 1 WHERE id = ?', s);
  }
  log('learn', `Feedback ${next > 0 ? '👍' : next < 0 ? '👎' : 'cleared'} on ${c.name}: ${c.sector} weight adj now ${Math.round(learned.sector[c.sector] * 100)}%`);
}

api.post('/leads/:id/enrich', wrap(async (req, res) => {
  const enr = await enrichCompany(Number(req.params.id));
  rescore(Number(req.params.id));
  res.json({ ok: true, enrichment: enr });
}));

// ---------- sprouts (on click only; every call is cached and capped) ----------
const sproutsWrap = (fn) => wrap(async (req, res) => {
  try { res.json(await fn(req)); } catch (e) { if (e instanceof SproutsError) return res.status(400).json({ error: e.message }); throw e; }
});
api.get('/leads/:id/sprouts', wrap((req, res) => res.json({ usage: sproutsUsage(), snapshot: cachedSnapshot(Number(req.params.id)) })));
api.post('/leads/:id/sprouts/snapshot', sproutsWrap(async (req) => ({ snapshot: await companySnapshot(Number(req.params.id), { refresh: Boolean(req.body?.refresh) }), usage: sproutsUsage() })));
api.post('/leads/:id/sprouts/people', sproutsWrap(async (req) => ({ ...(await findDecisionMakers(Number(req.params.id))), usage: sproutsUsage() })));
api.post('/contacts/:id/linkedin', sproutsWrap(async (req) => ({ ...(await findLinkedIn(Number(req.params.id))), usage: sproutsUsage() })));

// ---------- traction (DataForSEO) ----------
api.get('/leads/:id/traction', wrap((req, res) => {
  const c = q.get('SELECT id, domain FROM companies WHERE id = ?', req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  res.json({ configured: tractionConfigured(), domain: c.domain, usage: usageToday(), traction: cachedTraction(c.id) });
}));

api.post('/leads/:id/traction', wrap(async (req, res) => {
  try {
    const t = await fetchTraction(Number(req.params.id), { refresh: Boolean(req.body?.refresh) });
    res.json({ ok: true, traction: t, usage: usageToday() });
  } catch (e) {
    if (e instanceof TractionError) return res.status(400).json({ error: e.message });
    throw e;
  }
}));

api.post('/leads/:id/lookalike', wrap((req, res) => {
  const ids = lookalike(Number(req.params.id));
  res.json({ ok: true, sources: ids });
}));

// ---------- intel ----------
api.get('/intel', wrap((req, res) => {
  const cat = req.query.category;
  const rows = cat && cat !== 'voice'
    ? q.all('SELECT i.*, s.name source_name FROM intel i LEFT JOIN sources s ON s.id = i.source_id WHERE i.category = ? ORDER BY COALESCE(i.published_at, i.created_at) DESC LIMIT 150', cat)
    : q.all(`SELECT i.*, s.name source_name FROM intel i LEFT JOIN sources s ON s.id = i.source_id WHERE i.category != 'voice' ORDER BY COALESCE(i.published_at, i.created_at) DESC LIMIT 150`);
  const counts = q.all(`SELECT category, COUNT(*) n FROM intel WHERE category != 'voice' GROUP BY category`);
  res.json({ items: rows.map((r) => ({ ...r, meta: J(r.meta, {}) })), counts });
}));

// ---------- reddit (buyer intent) ----------
api.get('/reddit', wrap((req, res) => {
  const where = [`i.category = 'voice'`];
  const p = [];
  const st = req.query.status || 'open';
  if (st === 'open') where.push(`i.status = 'new'`);
  else if (['replied', 'lead', 'ignored'].includes(st)) { where.push('i.status = ?'); p.push(st); }
  const band = REDDIT_BANDS.find((b) => b.id === req.query.band);
  if (band) { const i = REDDIT_BANDS.indexOf(band); where.push('COALESCE(i.score, 0) >= ?'); p.push(band.min); if (i > 0) { where.push('COALESCE(i.score, 0) < ?'); p.push(REDDIT_BANDS[i - 1].min); } }
  const rows = q.all(`SELECT i.*, s.name source_name FROM intel i LEFT JOIN sources s ON s.id = i.source_id WHERE ${where.join(' AND ')}
    ORDER BY COALESCE(i.published_at, i.created_at) DESC LIMIT 300`, ...p).map((r) => ({ ...r, meta: J(r.meta, {}) }));
  const items = rows.filter((r) => (!req.query.segment || r.meta.segment === req.query.segment) && (!req.query.intent || (r.meta.intents || []).includes(req.query.intent)));
  const facet = (k) => rows.reduce((m, r) => { for (const v of [].concat(k === 'intent' ? r.meta.intents || [] : r.meta[k] || [])) m[v] = (m[v] || 0) + 1; return m; }, {});
  const status = Object.fromEntries(q.all(`SELECT status, COUNT(*) n FROM intel WHERE category = 'voice' GROUP BY status`).map((r) => [r.status, r.n]));
  res.json({ items: items.slice(0, 300).map((r) => ({ ...r, band: bandOf(r.score || 0) })), bands: REDDIT_BANDS, segments: REDDIT_SEGMENTS, intents: REDDIT_INTENTS, facets: { segment: facet('segment'), intent: facet('intent') }, status });
}));

// Weekly voice-of-customer report: what people ask, which providers they complain about, and which subs yield leads.
api.get('/reddit/report', wrap((req, res) => {
  const since = new Date(Date.now() - 7 * 86400000).toISOString();
  const rows = q.all(`SELECT score, status, meta FROM intel WHERE category = 'voice' AND COALESCE(published_at, created_at) > ?`, since).map((r) => ({ ...r, meta: J(r.meta, {}) }));
  const count = (fn) => rows.reduce((m, r) => { for (const k of [].concat(fn(r) || [])) m[k] = (m[k] || 0) + 1; return m; }, {});
  const subs = {};
  for (const r of rows) {
    for (const sub of String(r.meta.sub || 'search').split('+')) {
      const x = (subs[sub] ||= { posts: 0, high: 0, replied: 0, lead: 0 });
      x.posts++; if ((r.score || 0) >= 80) x.high++; if (r.status === 'replied') x.replied++; if (r.status === 'lead') x.lead++;
    }
  }
  res.json({
    since, total: rows.length,
    bands: count((r) => bandOf(r.score || 0).id),
    intents: count((r) => r.meta.intents),
    segments: count((r) => r.meta.segment),
    fit: count((r) => r.meta.fit),
    providers: count((r) => r.meta.providers),
    complaints: count((r) => (r.meta.unhappy ? r.meta.providers : [])),
    restricted: rows.filter((r) => r.meta.restricted).length,
    subs: Object.entries(subs).map(([sub, v]) => ({ sub, ...v })).sort((a, b) => b.lead - a.lead || b.high - a.high || b.posts - a.posts).slice(0, 12),
  });
}));

api.patch('/reddit/:id', wrap((req, res) => {
  const st = req.body?.status;
  if (!['new', 'replied', 'lead', 'ignored'].includes(st)) throw new Error('status must be new, replied, lead or ignored');
  const r = q.run(`UPDATE intel SET status = ? WHERE id = ? AND category = 'voice'`, st, Number(req.params.id));
  if (!r.changes) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
}));

// ---------- sources ----------
api.get('/sources', wrap((req, res) => {
  const rows = q.all(`SELECT * FROM sources ORDER BY enabled DESC, created_by = 'agent', category, name`);
  const running = new Set(runningSources());
  res.json(rows.map((s) => ({ ...s, params: J(s.params, {}), running: running.has(s.id), quality: s.approved + s.rejected ? Math.round((s.approved / (s.approved + s.rejected)) * 100) : null })));
}));

function sourceFromBody(b) {
  const kind = b.kind;
  if (!SOURCE_KINDS.includes(kind)) throw new Error(`kind must be one of ${SOURCE_KINDS.join(', ')}`);
  const category = ['leads', 'intel', 'voice'].includes(b.category) ? b.category : kind === 'reddit' ? 'voice' : 'leads';
  let params, name;
  if (kind === 'ashby') {
    if (!/^[a-z0-9_-]+$/i.test(b.board || '')) throw new Error('Enter an Ashby board name');
    params = { board: b.board, company: b.name || b.board }; name = params.company;
  }
  else if (kind === 'rss' || kind === 'reader') { if (!/^https?:\/\//.test(b.url || '')) throw new Error('A valid feed URL is required'); params = { url: b.url }; name = b.name || new URL(b.url).hostname; }
  else if (kind === 'gnews') { if (!b.query) throw new Error('query is required'); params = { query: b.query }; name = b.name || `GNews: ${b.query}`; }
  else if (kind === 'reddit') { if (!b.sub && !b.search) throw new Error('sub or search is required'); params = { sub: b.sub || undefined, search: b.search || undefined }; name = b.name || (b.sub ? `Reddit r/${b.sub}` : `Reddit: ${b.search}`); }
  else if (kind === 'hn') { if (!b.query) throw new Error('query is required'); params = { query: b.query, days: 45 }; name = b.name || `HN: ${b.query}`; }
  else throw new Error('This kind cannot be added manually');
  return { id: `user-${sha1(kind + JSON.stringify(params)).slice(0, 10)}`, name, kind, category, params };
}

api.post('/sources/test', wrap(async (req, res) => {
  const s = sourceFromBody(req.body || {});
  const items = await fetchSource(s);
  res.json({ ok: true, count: items.length, sample: items.slice(0, 5).map((i) => ({ title: i.title, date: i.published_at })) });
}));

api.post('/sources', wrap(async (req, res) => {
  const s = sourceFromBody(req.body || {});
  if (q.get('SELECT 1 FROM sources WHERE id = ?', s.id)) throw new Error('This source already exists');
  const items = await fetchSource(s); // validates before saving
  const cadence = Math.max(5, Number(req.body.cadence_min) || (['reader', 'ashby', 'reddit'].includes(s.kind) ? 15 : 120));
  q.run('INSERT INTO sources(id, name, kind, category, params, cadence_min, created_by) VALUES(?,?,?,?,?,?,?)', s.id, s.name, s.kind, s.category, JSON.stringify(s.params), cadence, 'user');
  const fresh = ingest({ ...s }, items);
  q.run('UPDATE sources SET last_run_at = ?, next_run_at = ?, last_status = ?, runs = 1, items_total = ? WHERE id = ?', nowIso(), new Date(Date.now() + cadence * 60000).toISOString(), 'ok', fresh, s.id);
  log('source', `Added ${s.name}: ${items.length} items, ${fresh} new`);
  res.json({ ok: true, id: s.id, fetched: items.length, fresh });
}));

api.patch('/sources/:id', wrap((req, res) => {
  const s = q.get('SELECT * FROM sources WHERE id = ?', req.params.id);
  if (!s) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {};
  if (typeof b.enabled === 'boolean') q.run('UPDATE sources SET enabled = ?, next_run_at = CASE WHEN ? THEN NULL ELSE next_run_at END, expires_at = CASE WHEN ? AND created_by = \'agent\' THEN NULL ELSE expires_at END WHERE id = ?', b.enabled ? 1 : 0, b.enabled ? 1 : 0, b.enabled ? 1 : 0, s.id);
  if (b.cadence_min) q.run('UPDATE sources SET cadence_min = ? WHERE id = ?', Math.max(5, Number(b.cadence_min)), s.id);
  if (b.category && ['leads', 'intel', 'voice'].includes(b.category)) q.run('UPDATE sources SET category = ? WHERE id = ?', b.category, s.id);
  res.json({ ok: true });
}));

api.delete('/sources/:id', wrap((req, res) => {
  const s = q.get('SELECT * FROM sources WHERE id = ?', req.params.id);
  if (!s) return res.status(404).json({ error: 'Not found' });
  if (s.created_by === 'system') q.run('UPDATE sources SET enabled = 0 WHERE id = ?', s.id);
  else q.run('DELETE FROM sources WHERE id = ?', s.id);
  res.json({ ok: true });
}));

api.post('/sources/:id/run', wrap(async (req, res) => {
  res.json(await runSource(req.params.id, { manual: true }));
}));

api.post('/scan', wrap((req, res) => {
  runAllNow();
  log('scan', 'Manual scan of all enabled sources triggered');
  res.json({ ok: true });
}));

api.post('/agent/run', wrap(async (req, res) => {
  const ids = await agentCycle({ force: true });
  res.json({ ok: true, added: ids || [] });
}));

// ---------- config ----------
api.get('/config', wrap((req, res) => res.json({ config: getConfig(), defaults: DEFAULT_CONFIG, learned: getSetting('learned', {}) })));

api.put('/config', wrap((req, res) => {
  const next = req.body?.config;
  if (!next || typeof next !== 'object') throw new Error('config object required');
  for (const k of ['weights', 'sectors', 'keywords']) if (next[k] && typeof next[k] !== 'object') throw new Error(`${k} must be an object`);
  const cfg = saveConfig(next);
  const n = rescoreAll();
  log('config', `Config saved; rescored ${n} companies`);
  res.json({ ok: true, config: cfg });
}));

api.post('/config/reset', wrap((req, res) => {
  const cfg = resetConfig();
  rescoreAll();
  res.json({ ok: true, config: cfg });
}));

// Live preview: how would the current top leads score under a draft config?
api.post('/config/preview', wrap((req, res) => {
  const draft = req.body?.config;
  if (!draft) throw new Error('config required');
  const rows = q.all(`SELECT * FROM companies WHERE status != 'dismissed' ORDER BY score DESC LIMIT 40`);
  const evs = eventsFor(rows.map((r) => r.id));
  const out = rows.map((c) => {
    const { score } = computeScore(c, evs.get(c.id) || [], draft);
    return { id: c.id, name: c.name, sector: c.sector, before: c.score, after: score };
  }).sort((a, b) => b.after - a.after);
  res.json({ preview: out.slice(0, 15), movedIntoHigh: out.filter((o) => o.after >= draft.threshold && o.before < draft.threshold).length, movedOutOfHigh: out.filter((o) => o.after < draft.threshold && o.before >= draft.threshold).length });
}));

// ---------- activity + live stream ----------
api.get('/activity', wrap((req, res) => res.json(recentActivity(Number(req.query.n) || 120))));

api.get('/runs', wrap((req, res) => res.json(q.all('SELECT r.*, s.name FROM runs r LEFT JOIN sources s ON s.id = r.source_id ORDER BY r.id DESC LIMIT 100'))));

api.get('/stream', (req, res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  res.write('retry: 3000\n\n');
  const send = (event) => (data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data ?? {})}\n\n`);
  const handlers = { activity: send('activity'), lead: send('lead'), intel: send('intel'), source: send('source'), stats: send('stats'), traction: send('traction') };
  for (const [k, h] of Object.entries(handlers)) bus.on(k, h);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(ping);
    for (const [k, h] of Object.entries(handlers)) bus.off(k, h);
  });
});

// Unauthenticated (platform healthcheck), so expose nothing sensitive.
api.get('/health', (req, res) => { q.get('SELECT 1'); res.json({ ok: true, auth: true, time: nowIso() }); });
