import { db } from '../db.js';

const limits = new Map();

export function rateLimit(key, max, windowMs) {
  const now = Date.now();
  if (limits.size >= 10000) {
    for (const [name, value] of limits) {
      if (value.until <= now) limits.delete(name);
    }
  }
  const previous = limits.get(key);
  if (!previous && limits.size >= 10000) return false;
  const current = previous && previous.until > now ? previous : { count: 0, until: now + windowMs };
  if (current.count >= max) return false;
  current.count++;
  limits.set(key, current);
  return true;
}

db.exec(`
  CREATE TABLE IF NOT EXISTS service_usage (
    service TEXT NOT NULL,
    day TEXT NOT NULL,
    calls INTEGER NOT NULL,
    PRIMARY KEY (service, day)
  )
`);

export function claimServiceCall(service, defaultCap) {
  const setting = process.env[`${service.toUpperCase()}_SHARED_DAILY_CAP`];
  const parsed = Number(setting);
  const cap = setting && Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : defaultCap;
  const day = new Date().toISOString().slice(0, 10);
  if (cap === 0 || !db.prepare(`
    INSERT INTO service_usage (service, day, calls) VALUES (?, ?, 1)
    ON CONFLICT (service, day) DO UPDATE SET calls = calls + 1 WHERE calls < ?
    RETURNING calls
  `).get(service, day, cap)) {
    throw new Error('This provider has reached the app-wide daily limit');
  }
}
