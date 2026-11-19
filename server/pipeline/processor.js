import { q, J, nowIso, workspaceId } from '../db.js';
import { getConfig } from '../config.js';
import { prefilter } from './prefilter.js';
import { saveIntel } from './intel-store.js';
import { extractBatch } from './extract.js';
import { upsertLead } from './resolve.js';
import { rescore } from './score.js';
import { enrichCompany } from './enrich.js';
import { targetPlan } from './people.js';
import { findEmail, providerStatus } from './email-finders.js';
import * as llm from './llm.js';
import { bus, log } from '../bus.js';

function sourceOf(id) {
  const source = q.get('SELECT * FROM sources WHERE id = ?', id);
  return source ? { ...source, params: J(source.params, {}) } : { id, name: id, kind: 'rss', category: 'leads', params: {} };
}

const processing = new Set();
const enriching = new Set();
export function processorStats() {
  return J(q.get("SELECT value FROM settings WHERE key = 'processor_stats'")?.value,
    { processed: 0, passed: 0, leadsNew: 0, eventsNew: 0, intelNew: 0, lastBatchAt: null, via: { llm: 0, rules: 0, structured: 0 } });
}

export async function processBatch() {
  const id = workspaceId();
  if (processing.has(id)) return;
  processing.add(id);
  try {
    const stats = processorStats();
    const cfg = getConfig();
    // Newest first so the demo always shows today's news quickly.
    const rows = q.all(`SELECT * FROM raw_items r WHERE status = 'new' AND NOT EXISTS (SELECT 1 FROM sources s WHERE s.id = r.source_id AND s.enabled = 0) ORDER BY COALESCE(published_at, fetched_at) DESC LIMIT 60`);
    if (!rows.length) return;

    const batch = [];
    for (const r of rows) {
      const source = sourceOf(r.source_id);
      const item = { ...r, meta: J(r.meta, {}) };
      const pf = prefilter(item, source);
      stats.processed++;
      if (!pf.pass) {
        q.run(`UPDATE raw_items SET status='filtered', prefilter=?, note=? WHERE id=?`, JSON.stringify(pf.hits), pf.reason, r.id);
        continue;
      }
      stats.passed++;
      q.run(`UPDATE raw_items SET status='processing', prefilter=? WHERE id=?`, JSON.stringify(pf.hits), r.id);
      q.run('UPDATE sources SET passed_total = passed_total + 1 WHERE id = ?', source.id);
      batch.push({ item, source, route: pf.route, cls: pf.cls, rawId: r.id });
      if (batch.length >= (llm.available() ? cfg.llm.batchSize : 25)) break;
    }
    if (!batch.length) {
      q.run(`INSERT OR REPLACE INTO settings VALUES ('processor_stats', ?)`, JSON.stringify(stats));
      return;
    }

    const results = await extractBatch(batch);
    const touched = new Set();
    batch.forEach((b, i) => {
      const r = results[i] || { leads: [], intel: null, via: 'rules' };
      stats.via[r.via] = (stats.via[r.via] || 0) + 1;
      let leadsHere = 0;
      for (const lead of r.leads || []) {
        if (lead.confidence != null && lead.confidence < 0.3) continue;
        const res = upsertLead(lead, b.item, b.source, b.rawId);
        if (!res) continue;
        touched.add(res.companyId);
        if (res.newCompany) { stats.leadsNew++; leadsHere++; }
        if (res.newEvent) stats.eventsNew++;
        if (res.newCompany || res.newEvent) {
          const c = q.get('SELECT id, name FROM companies WHERE id = ?', res.companyId);
          bus.emit('lead', { id: c.id, name: c.name, kind: res.newCompany ? 'new' : 'update', source: b.source.name });
        }
      }
      if (leadsHere) q.run('UPDATE sources SET leads_total = leads_total + ? WHERE id = ?', leadsHere, b.source.id);
      if (r.intel && saveIntel(r.intel, b.item, b.source, b.rawId)) {
        stats.intelNew++;
        bus.emit('intel', { title: r.intel.title || b.item.title, category: r.intel.category });
      }
      q.run(`UPDATE raw_items SET status='done', note=? WHERE id=?`, `${r.via}: ${(r.leads || []).length} lead(s)${r.intel ? ', intel' : ''}`, b.rawId);
    });
    for (const id of touched) rescore(id);
    stats.lastBatchAt = nowIso();
    q.run(`INSERT OR REPLACE INTO settings VALUES ('processor_stats', ?)`, JSON.stringify(stats));
    const v = results[0]?.via;
    log('process', `Processed ${batch.length} items via ${v}: ${touched.size} companies touched`);
    bus.emit('stats');
  } catch (e) {
    log('error', `Processor: ${e.message}`);
    q.run(`UPDATE raw_items SET status='new' WHERE status='processing'`);
  } finally {
    processing.delete(id);
  }
}

export async function enrichLoop() {
  const workspace = workspaceId();
  if (enriching.has(workspace) || enriching.size >= 3) return;
  enriching.add(workspace);
  try {
    const cfg = getConfig();
    // people_checked_at IS NULL also picks up companies enriched before people research existed.
    const rows = q.all(`SELECT id FROM companies WHERE (enriched_at IS NULL OR people_checked_at IS NULL) AND status != 'dismissed' AND score >= ? AND size != 'enterprise' ORDER BY score DESC LIMIT ?`, cfg.enrichment.minScore, cfg.enrichment.perCycle);
    for (const { id } of rows) {
      await enrichCompany(id);
      rescore(id);
      await autoFindEmail(id, cfg);
      bus.emit('lead', { id, kind: 'enriched' });
    }
  } catch (e) {
    log('error', `Enrichment: ${e.message}`);
  } finally {
    enriching.delete(workspace);
  }
}

// Optional: spend a paid lookup on the primary contact of high-intent leads (off by default).
async function autoFindEmail(id, cfg) {
  const min = cfg.contacts?.autoFindEmailMinScore || 0;
  if (!min) return;
  const c = q.get('SELECT * FROM companies WHERE id = ?', id);
  if (!c || c.score < min) return;
  const st = providerStatus();
  if (!st.configured.length || st.used >= st.cap) return;
  const plan = targetPlan(c);
  const primary = plan.primaryId && q.get('SELECT * FROM contacts WHERE id = ?', plan.primaryId);
  if (!primary || primary.email || primary.email_checked_at) return;
  await findEmail(primary.id).catch((e) => log('error', `Email lookup: ${e.message}`));
}

export const queueDepth = () => q.get(`SELECT COUNT(*) n FROM raw_items WHERE status IN ('new','processing')`).n;
