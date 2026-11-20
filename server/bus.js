import { EventEmitter } from 'node:events';
import { q, J, workspaceId, WorkspaceDeletedError } from './db.js';

const events = new EventEmitter();
events.setMaxListeners(0);
const channel = (event) => `${workspaceId() || 'catalog'}:${event}`;

export const bus = {
  emit: (event, data) => events.emit(channel(event), data),
  on(event, handler) {
    const key = channel(event);
    events.on(key, handler);
    return () => events.off(key, handler);
  },
};

export function log(type, msg, data) {
  const entry = { ts: new Date().toISOString(), type, msg, ...(data ? { data } : {}) };
  try {
    q.run('INSERT INTO activity (entry) VALUES (?)', JSON.stringify(entry));
    q.run('DELETE FROM activity WHERE id <= (SELECT MAX(id) - 400 FROM activity)');
  } catch (error) {
    if (error instanceof WorkspaceDeletedError) return;
    throw error;
  }
  bus.emit('activity', entry);
  if (!workspaceId() && process.env.QUIET !== '1') {
    console.log(`[${entry.ts.slice(11, 19)}] ${type.padEnd(8)} ${msg}`);
  }
}

export function recentActivity(n = 100) {
  return q.all('SELECT entry FROM activity ORDER BY id DESC LIMIT ?', Math.max(1, Math.min(400, Math.floor(n))))
    .map(({ entry }) => J(entry, {}));
}
