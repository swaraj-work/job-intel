import { AsyncLocalStorage } from 'node:async_hooks';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

// On Railway, an attached volume is exposed as RAILWAY_VOLUME_MOUNT_PATH; keep the DB there so it survives deploys.
const DB_PATH = process.env.DB_PATH
  || (process.env.RAILWAY_VOLUME_MOUNT_PATH && path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'jobintel.db'))
  || path.resolve('data/jobintel.db');
const WORKSPACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const scope = new AsyncLocalStorage();
const workspaces = new Map();
const workspaceDir = path.resolve(process.env.WORKSPACE_DIR || `${DB_PATH}.workspaces`);

export const workspaceId = () => scope.getStore() || null;

export function inWorkspace(id, fn) {
  if (!WORKSPACE_ID.test(id)) throw new Error('Invalid workspace ID');
  return scope.run(id, fn);
}

export const inCatalog = (fn) => scope.run(null, fn);

function addColumn(db, table, column, type) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some(({ name }) => name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

function openDatabase(filename, catalog = false) {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(filename);
  if (catalog && db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'settings'").get() &&
      !db.prepare("SELECT 1 FROM settings WHERE key = 'multi_user_catalog'").get()) {
    db.close();
    throw new Error('DB_PATH points to an existing single-user database. Set DB_PATH to a fresh catalog file.');
  }
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,                -- rss | gnews | reddit | hn | yc
  category TEXT NOT NULL DEFAULT 'leads', -- leads | intel | voice
  params TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  cadence_min INTEGER NOT NULL DEFAULT 60,
  min_cadence INTEGER NOT NULL DEFAULT 20,
  max_cadence INTEGER NOT NULL DEFAULT 720,
  created_by TEXT NOT NULL DEFAULT 'system', -- system | user | agent
  expires_at TEXT,
  last_run_at TEXT,
  next_run_at TEXT,
  last_status TEXT,
  last_error TEXT,
  runs INTEGER NOT NULL DEFAULT 0,
  items_total INTEGER NOT NULL DEFAULT 0,
  passed_total INTEGER NOT NULL DEFAULT 0,
  leads_total INTEGER NOT NULL DEFAULT 0,
  approved INTEGER NOT NULL DEFAULT 0,
  rejected INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS raw_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL,
  url TEXT NOT NULL,
  url_hash TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  summary TEXT,
  published_at TEXT,
  fetched_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  status TEXT NOT NULL DEFAULT 'new', -- new | filtered | dup | processing | done | error
  prefilter TEXT,
  meta TEXT,
  note TEXT
);
CREATE INDEX IF NOT EXISTS idx_raw_published ON raw_items(published_at DESC);
CREATE INDEX IF NOT EXISTS idx_raw_status ON raw_items(status, id);
CREATE INDEX IF NOT EXISTS idx_raw_fetched ON raw_items(fetched_at);

CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  norm_name TEXT NOT NULL,
  domain TEXT,
  aliases TEXT NOT NULL DEFAULT '[]',
  sector TEXT,
  city TEXT,
  description TEXT,
  website TEXT,
  logo TEXT,
  size TEXT,
  is_indian INTEGER NOT NULL DEFAULT 1,
  sells_intl TEXT,
  markets TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'new', -- new | reviewed | contacted | qualified | dismissed
  feedback INTEGER NOT NULL DEFAULT 0,
  score INTEGER NOT NULL DEFAULT 0,
  breakdown TEXT NOT NULL DEFAULT '[]',
  why TEXT,
  pitch TEXT,
  enrichment TEXT,
  enriched_at TEXT,
  notes TEXT NOT NULL DEFAULT '',
  confidence REAL NOT NULL DEFAULT 0.5,
  first_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_event_at TEXT,
  seen_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_comp_norm ON companies(norm_name);
CREATE INDEX IF NOT EXISTS idx_comp_domain ON companies(domain);
CREATE INDEX IF NOT EXISTS idx_comp_score ON companies(score DESC);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  raw_item_id INTEGER,
  source_id TEXT,
  type TEXT NOT NULL, -- funding | expansion | launch | export | hiring | pain | partnership | acquisition | directory | other
  title TEXT NOT NULL,
  summary TEXT,
  url TEXT,
  stage TEXT,
  amount_text TEXT,
  amount_usd_m REAL,
  investors TEXT NOT NULL DEFAULT '[]',
  markets TEXT NOT NULL DEFAULT '[]',
  signals TEXT NOT NULL DEFAULT '[]',
  competitors TEXT NOT NULL DEFAULT '[]',
  confidence REAL NOT NULL DEFAULT 0.5,
  corroborations INTEGER NOT NULL DEFAULT 1,
  extra_urls TEXT NOT NULL DEFAULT '[]',
  occurred_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_events_raw ON events(raw_item_id);
CREATE INDEX IF NOT EXISTS idx_events_company ON events(company_id, created_at);
CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);

CREATE TABLE IF NOT EXISTS intel (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  raw_item_id INTEGER,
  source_id TEXT,
  category TEXT NOT NULL, -- regulatory | competitor | market | voice
  title TEXT NOT NULL,
  summary TEXT,
  so_what TEXT,
  importance INTEGER NOT NULL DEFAULT 2, -- 1..3
  url TEXT,
  published_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_intel_created ON intel(created_at);

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT,
  fetched INTEGER DEFAULT 0,
  new_items INTEGER DEFAULT 0,
  error TEXT
);

CREATE TABLE IF NOT EXISTS llm_usage (
  day TEXT PRIMARY KEY,
  calls INTEGER NOT NULL DEFAULT 0,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0
);
`);

// People at a company we might reach out to. Every row records where it came from (DPDP provenance).
  db.exec(`
CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  norm_name TEXT NOT NULL,
  role TEXT,
  email TEXT,
  email_status TEXT,          -- verified | risky (accept-all domain) | null
  email_source TEXT,          -- apollo | hunter | manual
  email_checked_at TEXT,
  linkedin TEXT,
  source TEXT NOT NULL,       -- article | website | news | yc | apollo | manual
  source_url TEXT,
  evidence TEXT,
  confidence REAL NOT NULL DEFAULT 0.6,
  do_not_contact INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(company_id, norm_name)
);
CREATE INDEX IF NOT EXISTS idx_contacts_company ON contacts(company_id);

CREATE TABLE IF NOT EXISTS outreach_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  contact_id INTEGER REFERENCES contacts(id),
  status TEXT NOT NULL, -- sent | replied | interview | offer | rejected
  subject TEXT,
  body TEXT,
  recipient_email TEXT,
  sent_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_outreach_sent ON outreach_log(sent_at);
CREATE INDEX IF NOT EXISTS idx_outreach_company ON outreach_log(company_id);
`);

  // Additive migrations for databases created by earlier versions (e.g. the Railway volume).
  addColumn(db, 'companies', 'team', 'TEXT');           // { min, max, exact, source, url, evidence, at }
  addColumn(db, 'companies', 'people_checked_at', 'TEXT');
  addColumn(db, 'companies', 'application_status', "TEXT NOT NULL DEFAULT 'new'"); // new | sent | replied | interview | offer | rejected | archived
  addColumn(db, 'companies', 'sent_at', 'TEXT');
  addColumn(db, 'companies', 'follow_up_at', 'TEXT');
  addColumn(db, 'companies', 'tech_stack', "TEXT NOT NULL DEFAULT '[]'");
  addColumn(db, 'companies', 'email_draft', 'TEXT');
  addColumn(db, 'companies', 'outreach_subject', 'TEXT');
  addColumn(db, 'companies', 'pitch_subject', 'TEXT');
  addColumn(db, 'companies', 'role_match', 'TEXT');
  addColumn(db, 'intel', 'meta', 'TEXT');                // classifier tags: topic, or Reddit sub/segment/intent/signals
  addColumn(db, 'intel', 'score', 'INTEGER');            // Reddit buyer-intent score 0..100
  addColumn(db, 'intel', 'status', "TEXT NOT NULL DEFAULT 'new'"); // Reddit triage: new | replied | lead | ignored
  addColumn(db, 'intel', 'coverage', 'INTEGER NOT NULL DEFAULT 1'); // how many outlets ran the same story

  db.exec(`CREATE TABLE IF NOT EXISTS traction (
  company_id INTEGER PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  domain TEXT NOT NULL,
  data TEXT,
  error TEXT,
  cost REAL NOT NULL DEFAULT 0,
  fetched_at TEXT NOT NULL
)`);

  db.exec(`CREATE TABLE IF NOT EXISTS sprouts_company (
  company_id INTEGER PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  domain TEXT NOT NULL,
  found INTEGER NOT NULL,
  data TEXT,          -- normalised fields shown in the UI
  raw TEXT,           -- the record as returned, so field mapping can be fixed later without paying again
  fetched_at TEXT NOT NULL
)`);
  // Ledger of every request, the basis for caps and the usage line in the UI.
  db.exec(`CREATE TABLE IF NOT EXISTS sprouts_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,       -- account | contact | enrich
  company_id INTEGER,
  contact_id INTEGER,
  records INTEGER NOT NULL DEFAULT 0,
  ok INTEGER NOT NULL DEFAULT 1,
  at TEXT NOT NULL
)`);
  addColumn(db, 'contacts', 'sprouts_checked_at', 'TEXT');
  db.exec(`
  CREATE TABLE IF NOT EXISTS activity (
    id INTEGER PRIMARY KEY,
    entry TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS job_state (
    raw_id INTEGER PRIMARY KEY REFERENCES raw_items(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('saved','applied','dismissed'))
  );
`);
  if (catalog) db.exec(`
    PRAGMA secure_delete = ON;
    INSERT OR IGNORE INTO settings VALUES ('multi_user_catalog', 'true');
    CREATE TABLE IF NOT EXISTS pending_workspace_deletions (id TEXT PRIMARY KEY);
  `);
  return db;
}

export const db = openDatabase(DB_PATH, true);

export class WorkspaceDeletedError extends Error {
  constructor() { super('This account has been deleted.'); }
}

export function workspaceExists(id) {
  return Boolean(db.prepare('SELECT 1 FROM users WHERE id = ?').get(id));
}

function workspaceFilename(id) {
  if (!WORKSPACE_ID.test(id)) throw new Error('Invalid workspace ID');
  return path.join(workspaceDir, `${id}.db`);
}

export function purgeWorkspace(id) {
  const filename = workspaceFilename(id);
  const connection = workspaces.get(id);
  workspaces.delete(id);
  try {
    connection?.close();
    for (const suffix of ['-wal', '-shm', '-journal', '']) fs.rmSync(filename + suffix, { force: true });
    db.prepare('DELETE FROM pending_workspace_deletions WHERE id = ?').run(id);
    return true;
  } catch (error) {
    console.error('Workspace deletion will be retried:', error.code || 'cleanup failed');
    return false;
  }
}

export function retryWorkspaceDeletions() {
  for (const { id } of db.prepare('SELECT id FROM pending_workspace_deletions').all()) purgeWorkspace(id);
}

function workspaceDatabase() {
  const id = workspaceId();
  if (!id) return db;
  let connection = workspaces.get(id);
  if (!connection) {
    if (!workspaceExists(id)) throw new WorkspaceDeletedError();
    connection = openDatabase(workspaceFilename(id));
  }
  workspaces.delete(id);
  workspaces.set(id, connection);
  if (workspaces.size > 32) {
    const [oldest, previous] = workspaces.entries().next().value;
    previous.close();
    workspaces.delete(oldest);
  }
  return connection;
}

export function closeDatabases() {
  for (const connection of workspaces.values()) connection.close();
  workspaces.clear();
  db.close();
}

export const nowIso = () => new Date().toISOString();

export const q = {
  get: (sql, ...p) => workspaceDatabase().prepare(sql).get(...p),
  all: (sql, ...p) => workspaceDatabase().prepare(sql).all(...p),
  run: (sql, ...p) => workspaceDatabase().prepare(sql).run(...p),
};

export function tx(fn) {
  const db = workspaceDatabase();
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export const J = (s, fb) => {
  if (s == null) return fb;
  try { return JSON.parse(s); } catch { return fb; }
};

export function getSetting(key, fallback) {
  const row = q.get('SELECT value FROM settings WHERE key = ?', key);
  return row ? J(row.value, fallback) : fallback;
}

export function setSetting(key, value) {
  q.run('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));
}
