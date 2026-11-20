import { q, J, nowIso, workspaceId, tx, workspaceExists } from './db.js';
import { fetchSource } from './sources/index.js';
import { canonicalUrl, sha1, tokens, jaccard, daysAgo } from './util/text.js';
import { getConfig } from './config.js';
import { bus, log } from './bus.js';

const MAX_CATALOG_RUNS = 4;
const MAX_PRIVATE_RUNS = 3;
const MAX_PER_WORKSPACE = 1;
const running = new Map();
let timer = null;

// Compare recent titles within the current discovery scope only.
function isNearDup(title) {
  const words = tokens(title);
  if (words.length < 4) return false;
  const since = new Date(Date.now() - 4 * 86400_000).toISOString();
  return q.all('SELECT title FROM raw_items WHERE fetched_at > ? ORDER BY id DESC LIMIT 250', since)
    .some(row => jaccard(words, tokens(row.title)) >= 0.75);
}

const runKey = (id) => `${workspaceId() || 'catalog'}:${id}`;

function hydrate(row) {
  return row && { ...row, params: J(row.params, {}) };
}

export function ingest(source, items) {
  const cfg = getConfig();
  let fresh = 0;
  const ins = 'INSERT OR IGNORE INTO raw_items(source_id, url, url_hash, title, summary, published_at, status, meta) VALUES(?,?,?,?,?,?,?,?)';
  for (const it of items) {
    if (typeof it.url !== 'string' || !/^https?:\/\//i.test(it.url) || typeof it.title !== 'string' || !it.title) continue;
    const url = canonicalUrl(it.url);
    const hash = sha1(url);
    const existing = q.get('SELECT published_at FROM raw_items WHERE url_hash = ?', hash);
    if (existing) {
      if (!existing.published_at && it.published_at) q.run('UPDATE raw_items SET published_at=? WHERE url_hash=?', it.published_at, hash);
      continue;
    }
    const tooOld = !it.meta?.entity && it.published_at && daysAgo(it.published_at) > cfg.maxItemAgeDays;
    const status = tooOld ? 'filtered' : !it.meta?.entity && !it.meta?.job && !it.meta?.hiringThread && !['reddit', 'xjobs'].includes(source.kind) && isNearDup(it.title) ? 'dup' : 'new';
    const r = q.run(ins, source.id, url, hash, it.title.slice(0, 500), it.summary || '', it.published_at || null, status, JSON.stringify(it.meta || {}));
    if (r.changes) fresh += status === 'new' ? 1 : 0;
  }
  return fresh;
}

export async function runSource(id, { manual = false } = {}) {
  const key = runKey(id);
  const workspace = workspaceId();
  const current = [...running.values()];
  const privateRuns = current.filter(run => run.workspace);
  if (running.has(key) || (workspace
    ? privateRuns.length >= MAX_PRIVATE_RUNS || privateRuns.filter(run => run.workspace === workspace).length >= MAX_PER_WORKSPACE
    : current.length - privateRuns.length >= MAX_CATALOG_RUNS)) return { skipped: true };
  const source = hydrate(q.get('SELECT * FROM sources WHERE id = ?', id));
  if (!source) throw new Error('Unknown source');
  if (workspaceId() && source.created_by === 'system') return { skipped: true, shared: true };
  if (!source.enabled) return { skipped: true };
  if (manual && source.last_run_at && Date.now() - Date.parse(source.last_run_at) < 60_000) return { skipped: true };
  const host = hostOf(source, source.params);
  if (current.some(run => run.host === host)) return { skipped: true };
  const started = nowIso();
  const run = q.run('INSERT INTO runs(source_id, started_at, status) VALUES(?,?,?)', id, started, 'running');
  running.set(key, { workspace, host });
  bus.emit('source', { id, status: 'running' });
  try {
    const items = await fetchSource(source);
    const currentSource = q.get('SELECT enabled, cadence_min, created_at FROM sources WHERE id = ?', id);
    if (!currentSource?.enabled || currentSource.created_at !== source.created_at) {
      q.run('UPDATE runs SET finished_at=?, status=? WHERE id=?', nowIso(), 'skipped', run.lastInsertRowid);
      return { skipped: true };
    }
    const jitter = 1 + (Math.random() * 0.2 - 0.1);
    const next = new Date(Date.now() + currentSource.cadence_min * 60000 * jitter).toISOString();
    const fresh = tx(() => {
      const added = ingest(source, items);
      q.run(`UPDATE sources SET last_run_at=?, next_run_at=?, last_status='ok', last_error=NULL, runs=runs+1, items_total=items_total+? WHERE id=?`, nowIso(), next, added, id);
      q.run('UPDATE runs SET finished_at=?, status=?, fetched=?, new_items=? WHERE id=?', nowIso(), 'ok', items.length, added, run.lastInsertRowid);
      return added;
    });
    log('fetch', `${source.name}: ${items.length} items, ${fresh} new${manual ? ' (manual)' : ''}`);
    bus.emit('source', { id, status: 'ok', fresh });
    return { fetched: items.length, fresh };
  } catch (e) {
    if (workspace && !workspaceExists(workspace)) return { skipped: true };
    if (e.status === 429 || e.status === 503) {
      // Rate limited: not a failure, just come back later.
      const later = new Date(Date.now() + (15 + Math.random() * 20) * 60000).toISOString();
      q.run(`UPDATE sources SET next_run_at=?, last_status='deferred', last_error=? WHERE id=?`, later, 'Rate limited by host, retrying later', id);
      q.run('UPDATE runs SET finished_at=?, status=?, error=? WHERE id=?', nowIso(), 'deferred', 'rate limited', run.lastInsertRowid);
      log('fetch', `${source.name}: rate limited, rescheduled`);
      bus.emit('source', { id, status: 'deferred' });
      return { deferred: true, error: 'Rate limited, rescheduled' };
    }
    const retry = new Date(Date.now() + Math.min(source.cadence_min, 30) * 60000).toISOString();
    q.run(`UPDATE sources SET last_run_at=?, next_run_at=?, last_status='error', last_error=?, runs=runs+1 WHERE id=?`, nowIso(), retry, e.message.slice(0, 300), id);
    q.run('UPDATE runs SET finished_at=?, status=?, error=? WHERE id=?', nowIso(), 'error', e.message.slice(0, 300), run.lastInsertRowid);
    log('error', `${source.name}: ${e.message}`);
    bus.emit('source', { id, status: 'error' });
    return { error: e.message };
  } finally {
    running.delete(key);
  }
}

function hostOf(s, p) {
  if (s.kind === 'gnews') return 'news.google.com';
  if (s.kind === 'reddit') return 'reddit';
  if (s.kind === 'reader') return 'r.jina.ai';
  if (s.kind === 'ashby') return 'api.ashbyhq.com';
  if (s.kind === 'hn' || s.kind === 'hnhiring') return 'hn.algolia.com';
  if (s.kind === 'yc') return 'yc-oss.github.io';
  try { return new URL(p.url).host; } catch { return s.id; }
}

export function tickSources() {
  const due = q.all(`SELECT id FROM sources WHERE enabled = 1 AND (next_run_at IS NULL OR next_run_at <= ?)
    AND (? = 0 OR created_by != 'system') ORDER BY next_run_at IS NOT NULL, next_run_at LIMIT 50`, nowIso(), workspaceId() ? 1 : 0);
  for (const s of due) void runSource(s.id).catch(error => log('error', `Source ${s.id}: ${error.message}`));
}

export function runAllNow() {
  q.run(`UPDATE sources SET next_run_at = NULL WHERE enabled = 1 AND created_by != 'system'`);
  tickSources();
}

export function runningSources() {
  const prefix = runKey('');
  return [...running.keys()].filter(key => key.startsWith(prefix)).map(key => key.slice(prefix.length));
}

export function startScheduler() {
  tickSources();
  timer = setInterval(tickSources, 10_000);
}

export function stopScheduler() {
  clearInterval(timer);
}
