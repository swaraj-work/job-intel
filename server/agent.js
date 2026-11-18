import { q, J, nowIso, getSetting, setSetting } from './db.js';
import { getConfig } from './config.js';
import { sha1 } from './util/text.js';
import * as llm from './pipeline/llm.js';
import { runSource } from './scheduler.js';
import { log } from './bus.js';

// The agent keeps discovery fresh: rotating/novel queries, pruning dead ones,
// tuning cadence by yield, and "find more like this" on demand.

const SEGMENTS = [
  'AI startup', 'SaaS startup', 'DevTools startup', 'fintech startup', 'deeptech startup',
  'healthtech startup', 'B2B startup', 'cloud startup', 'developer tools startup', 'robotics startup'
];
const INTENTS = [
  'raises seed funding', 'raises pre-seed', 'raises Series A', 'seed round',
  'hiring software engineering interns', 'hiring junior full stack', 'SDE 1 hiring', 'new grad AI engineer',
  'hiring junior backend developer', 'fresher developer opening'
];

function addAgentQuery(query, name, why) {
  const cfg = getConfig();
  const id = `agent-${sha1(query).slice(0, 10)}`;
  if (q.get('SELECT 1 FROM sources WHERE id = ?', id)) return null;
  const expires = new Date(Date.now() + cfg.agent.queryTtlDays * 86400000).toISOString();
  q.run(`INSERT INTO sources(id, name, kind, category, params, cadence_min, min_cadence, max_cadence, created_by, expires_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`, id, name || `Agent: ${query.replace(/ when:\d+d$/, '')}`, 'gnews', 'leads', JSON.stringify({ query, why }), 240, 120, 1440, 'agent', expires);
  log('agent', `New query "${query}"${why ? ` (${why})` : ''}`);
  return id;
}

function templateQueries(n) {
  const used = new Set(getSetting('agent_used', []));
  const combos = [];
  for (const s of SEGMENTS) for (const i of INTENTS) combos.push(`India ${s} ${i}`);
  const fresh = combos.filter((c) => !used.has(c));
  const pool = fresh.length >= n ? fresh : combos;
  const picks = [];
  while (picks.length < n && pool.length) picks.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  setSetting('agent_used', [...used, ...picks].slice(-300));
  return picks.map((p) => ({ query: `${p} when:2d`, why: 'rotation' }));
}

async function llmQueries(n) {
  const top = q.all(`SELECT name, sector FROM companies WHERE status != 'dismissed' ORDER BY score DESC LIMIT 10`);
  const existing = q.all(`SELECT params FROM sources WHERE kind = 'gnews' AND enabled = 1`).map((r) => J(r.params, {}).query);
  const out = await llm.json(
    'You plan high-yield news searches to discover early-stage startups that just raised seed/pre-seed capital or posted fresh "we are hiring" developer alerts. Each query runs on Google News RSS. Prefer phrasing like ("seed round" OR "pre-seed" India startup) or ("hiring software engineering interns" startup). Avoid generic market fluff.',
    `Top scored targets: ${JSON.stringify(top)}\nQueries already running: ${JSON.stringify(existing)}\n\nPropose ${n} NEW queries. Use Google News operators (OR, quotes). Append " when:7d" or " when:3d". Return {"queries":[{"query":"...","why":"<=8 words"}]}`,
    { type: 'OBJECT', properties: { queries: { type: 'ARRAY', items: { type: 'OBJECT', properties: { query: { type: 'STRING' }, why: { type: 'STRING' } }, required: ['query', 'why'] } } }, required: ['queries'] },
    { temperature: 0.8, maxTokens: 800 },
  );
  return (out.queries || []).slice(0, n).map((x) => ({ query: /when:\d+d/.test(x.query) ? x.query : `${x.query} when:7d`, why: x.why }));
}

function pruneAndTune() {
  const cfg = getConfig();
  // Expired agent queries: extend once if they produced leads, else retire.
  for (const s of q.all(`SELECT * FROM sources WHERE created_by = 'agent' AND enabled = 1 AND expires_at < ?`, nowIso())) {
    const p = J(s.params, {});
    if (s.leads_total > 0 && !p.extended) {
      q.run('UPDATE sources SET expires_at = ?, params = ? WHERE id = ?', new Date(Date.now() + cfg.agent.queryTtlDays * 86400000).toISOString(), JSON.stringify({ ...p, extended: true }), s.id);
      log('agent', `Extended productive query "${p.query}" (${s.leads_total} leads)`);
    } else {
      q.run('UPDATE sources SET enabled = 0 WHERE id = ?', s.id);
      log('agent', `Retired query "${p.query}" (${s.leads_total} leads)`);
    }
  }
  // Cadence by yield: quiet sources slow down, busy ones speed up.
  for (const s of q.all('SELECT * FROM sources WHERE enabled = 1')) {
    const last = q.all(`SELECT new_items FROM runs WHERE source_id = ? AND status = 'ok' ORDER BY id DESC LIMIT 4`, s.id);
    if (last.length < 3) continue;
    const avg = last.reduce((a, r) => a + r.new_items, 0) / last.length;
    let cad = s.cadence_min;
    if (avg === 0) cad = Math.min(s.max_cadence, Math.round(cad * 1.5));
    else if (avg >= 8) cad = Math.max(s.min_cadence, Math.round(cad * 0.75));
    if (cad !== s.cadence_min) q.run('UPDATE sources SET cadence_min = ? WHERE id = ?', cad, s.id);
  }
}

export async function agentCycle({ force = false } = {}) {
  const cfg = getConfig();
  if (!cfg.agent.enabled && !force) return;
  const last = getSetting('agent_last_run', null);
  if (!force && last && Date.now() - new Date(last).getTime() < cfg.agent.intervalMinutes * 60000) return;
  setSetting('agent_last_run', nowIso());
  pruneAndTune();
  let plans = [];
  if (llm.available()) {
    try { plans = await llmQueries(cfg.agent.queriesPerCycle); } catch (e) { log('agent', `LLM planning failed, using rotation: ${e.message}`); }
  }
  if (!plans.length) plans = templateQueries(cfg.agent.queriesPerCycle);
  const ids = plans.map((p) => addAgentQuery(p.query, null, p.why)).filter(Boolean);
  for (const id of ids) runSource(id).catch(() => {});
  return ids;
}

export function lookalike(companyId) {
  const c = q.get('SELECT * FROM companies WHERE id = ?', companyId);
  if (!c) return null;
  const seg = { SaaS: 'SaaS startup', AI: 'AI startup', D2C: 'D2C brand', Exporter: 'exporter', Edtech: 'edtech startup', Travel: 'travel startup', 'IT Services': 'IT services company', Agency: 'agency', Manufacturing: 'manufacturer', Gaming: 'gaming studio', Marketplace: 'marketplace' }[c.sector] || 'startup';
  const queries = [
    `Indian ${seg} ("engineering intern" OR "SDE 1" OR "junior engineer") hiring when:3d`,
    `Indian ${seg} raises seed funding when:7d`,
  ];
  const ids = queries.map((qq) => addAgentQuery(qq, `Lookalike of ${c.name}: ${qq.replace(/ when:\d+d$/, '')}`, `like ${c.name}`)).filter(Boolean);
  for (const id of ids) runSource(id).catch(() => {});
  return ids;
}

export function startAgent() {
  setTimeout(() => agentCycle().catch((e) => log('error', `Agent: ${e.message}`)), 90_000);
  setInterval(() => agentCycle().catch((e) => log('error', `Agent: ${e.message}`)), 5 * 60_000);
}
