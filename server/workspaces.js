import { q, tx, inCatalog, inWorkspace, getSetting, setSetting, workspaceId, retryWorkspaceDeletions } from './db.js';
import { SEED_SOURCES, RETIRED_SOURCES } from './sources/index.js';
import { tickSources } from './scheduler.js';
import { processBatch, enrichLoop } from './pipeline/processor.js';
import { agentCycle } from './agent.js';
import { bus, log } from './bus.js';

const active = new Map();
const ACTIVE_LIMIT = 32;
const ACTIVE_MS = 30 * 60_000;
const SYNC_MS = 30_000;
const working = new Set();

export function seedSources() {
  for (const s of SEED_SOURCES) {
    const key = { xjobs: 'X_BEARER_TOKEN', indexedjobs: 'SERPAPI_API_KEY' }[s.kind];
    const enabled = key ? Boolean(process.env[key]) : s.enabled !== false;
    q.run(`INSERT INTO sources (id, name, kind, category, params, cadence_min, min_cadence, max_cadence, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, params = excluded.params WHERE sources.created_by = 'system'`,
    s.id, s.name, s.kind, s.category || 'leads', JSON.stringify(s.params), s.cadence_min || 60,
    s.min_cadence || 15, s.max_cadence || 720, Number(enabled));
    if (key && !workspaceId()) q.run('UPDATE sources SET enabled = ? WHERE id = ?', Number(enabled), s.id);
  }
  for (const id of RETIRED_SOURCES) q.run("UPDATE sources SET enabled = 0 WHERE id = ? AND created_by = 'system'", id);
}

export function initializeDiscovery() {
  seedSources();
  q.run(`CREATE TABLE IF NOT EXISTS catalog_changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    raw_id INTEGER NOT NULL REFERENCES raw_items(id) ON DELETE CASCADE
  )`);
  q.run(`CREATE TRIGGER IF NOT EXISTS catalog_post_insert AFTER INSERT ON raw_items
    BEGIN INSERT INTO catalog_changes(raw_id) VALUES (new.id); END`);
  q.run(`CREATE TRIGGER IF NOT EXISTS catalog_post_date AFTER UPDATE OF published_at ON raw_items
    BEGIN INSERT INTO catalog_changes(raw_id) VALUES (new.id); END`);
}

function syncDiscovery() {
  const cursor = getSetting('catalog_cursor', null);
  const { sources, posts, nextCursor } = inCatalog(() => {
    const sources = q.all("SELECT * FROM sources WHERE created_by = 'system'");
    if (cursor === null) {
      const since = new Date(Date.now() - 7 * 86400_000).toISOString();
      const posts = q.all(`SELECT r.* FROM raw_items r JOIN sources s ON s.id = r.source_id
        WHERE s.created_by = 'system' AND (COALESCE(r.published_at, r.fetched_at) >= ?
        OR (r.meta LIKE '%"entity"%' AND r.fetched_at >= ?)) ORDER BY r.id DESC LIMIT 10000`, since, since);
      return { sources, posts, nextCursor: q.get('SELECT COALESCE(MAX(id), 0) AS id FROM catalog_changes').id };
    }
    const posts = q.all(`SELECT r.*, change.id AS revision FROM catalog_changes change
      JOIN raw_items r ON r.id = change.raw_id JOIN sources s ON s.id = r.source_id
      WHERE change.id > ? AND s.created_by = 'system' ORDER BY change.id LIMIT 2000`, cursor);
    return { sources, posts, nextCursor: posts.at(-1)?.revision ?? cursor };
  });

  tx(() => {
    seedSources();
    for (const source of sources) {
      q.run(`UPDATE sources SET last_run_at = ?, last_status = ?, last_error = ?, runs = ?, items_total = ?
        WHERE id = ? AND created_by = 'system'`, source.last_run_at, source.last_status, source.last_error,
      source.runs, source.items_total, source.id);
    }
    for (const post of posts) {
      q.run(`INSERT INTO raw_items (source_id, url, url_hash, title, summary, published_at, fetched_at, status, meta)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (url_hash) DO UPDATE
        SET published_at = excluded.published_at WHERE raw_items.published_at IS NULL AND excluded.published_at IS NOT NULL`,
      post.source_id, post.url, post.url_hash, post.title, post.summary, post.published_at, post.fetched_at,
      post.status === 'filtered' || post.status === 'dup' ? post.status : 'new', post.meta);
    }
    if (nextCursor !== cursor) setSetting('catalog_cursor', nextCursor);
  });
  if (posts.length) bus.emit('stats');
}

export function activateWorkspace(account) {
  const id = workspaceId();
  const now = Date.now();
  let state = active.get(id);
  if (!state) {
    state = { lastSync: 0, lastSeen: now, nextEnrichment: 0, nextAgent: 0 };
    // Reset interrupted batches when the process has no active worker for this workspace.
    if (!working.has(id)) q.run("UPDATE raw_items SET status = 'new' WHERE status = 'processing'");
    if (!getSetting('profile_initialized', false)) {
      tx(() => {
        setSetting('config', { candidate: { name: account.name } });
        setSetting('profile_initialized', true);
      });
    }
  }
  if (now - state.lastSync >= SYNC_MS) {
    syncDiscovery();
    state.lastSync = now;
  }
  state.lastSeen = now;
  active.delete(id);
  active.set(id, state);
  if (active.size > ACTIVE_LIMIT) active.delete(active.keys().next().value);
}

export function deactivateWorkspace(id) {
  active.delete(id);
  bus.emit('account-deleted');
}

export async function runWorkspaceTick() {
  if (working.size >= 3) return;
  try {
    const now = Date.now();
    for (const [id, state] of active) {
      if (now - state.lastSeen > ACTIVE_MS) active.delete(id);
    }
    const entry = [...active.entries()].filter(([id]) => !working.has(id)).sort((a, b) => (a[1].lastWorked || 0) - (b[1].lastWorked || 0))[0];
    if (!entry) return;
    const [id, state] = entry;
    state.lastWorked = now;
    working.add(id);
    try {
      await inWorkspace(id, async () => {
        if (now - state.lastSync >= SYNC_MS) {
          syncDiscovery();
          state.lastSync = now;
        }
        tickSources();
        // Slow enrichment and source fetches may overlap with other workspaces.
        if (now >= state.nextEnrichment) {
          state.nextEnrichment = now + 30_000;
          void enrichLoop();
        }
        if (process.env.DISABLE_AGENT !== '1' && now >= state.nextAgent) {
          state.nextAgent = now + 5 * 60_000;
          void agentCycle().catch(error => log('error', `Agent: ${error.message}`));
        }
        await processBatch();
      });
    } finally {
      working.delete(id);
    }
  } catch (error) {
    console.error('Workspace worker:', error.message);
  }
}

export function startWorkspaceWorker() {
  retryWorkspaceDeletions();
  const timer = setInterval(() => void runWorkspaceTick(), 3000);
  const cleanup = setInterval(retryWorkspaceDeletions, 60_000);
  return () => {
    clearInterval(timer);
    clearInterval(cleanup);
  };
}
