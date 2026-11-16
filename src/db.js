import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR } from './config.js';

const RETENTION_DAYS = Number(process.env.LOG_RETENTION_DAYS) || 365;

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'events.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  CREATE TABLE IF NOT EXISTS events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    at         TEXT NOT NULL,
    type       TEXT NOT NULL,
    level      TEXT NOT NULL DEFAULT 'info',
    msg        TEXT NOT NULL,
    outcome    TEXT,
    group_id   TEXT,
    group_name TEXT,
    sender     TEXT,
    name       TEXT,
    reason     TEXT,
    excerpt    TEXT
  );
  CREATE INDEX IF NOT EXISTS events_type ON events (type, id);
  CREATE INDEX IF NOT EXISTS events_outcome ON events (outcome, id);
  CREATE INDEX IF NOT EXISTS events_at ON events (at);
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
`);

db.prepare('DELETE FROM events WHERE at < ?').run(new Date(Date.now() - RETENTION_DAYS * 86400000).toISOString());

const insertStmt = db.prepare(`
  INSERT INTO events (at, type, level, msg, outcome, group_id, group_name, sender, name, reason, excerpt)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

export function addEvent(e) {
  insertStmt.run(
    e.at,
    e.type || 'info',
    e.level || 'info',
    e.msg,
    e.outcome ?? null,
    e.groupId ?? null,
    e.group ?? null,
    e.sender ?? null,
    e.name ?? null,
    e.reason ?? null,
    e.excerpt ?? null,
  );
}

const toEvent = (r) => ({
  id: r.id,
  at: r.at,
  type: r.type,
  level: r.level,
  msg: r.msg,
  outcome: r.outcome,
  groupId: r.group_id,
  group: r.group_name,
  sender: r.sender,
  name: r.name,
  reason: r.reason,
  excerpt: r.excerpt,
});

function buildWhere({ type, q, group, outcome, from, to, before }) {
  const where = [];
  const params = [];
  if (type === 'spam') where.push("type = 'spam'");
  else if (type === 'sys') where.push("type <> 'spam'");
  else if (type === 'problem') where.push("level IN ('warn', 'error')");
  if (outcome) {
    where.push('outcome = ?');
    params.push(outcome);
  }
  if (group) {
    where.push('group_name = ?');
    params.push(group);
  }
  if (from) {
    where.push('at >= ?');
    params.push(from);
  }
  if (to) {
    where.push('at < ?');
    params.push(to);
  }
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
    const cols = ['msg', 'excerpt', 'sender', 'name', 'group_name', 'reason'];
    where.push(`(${cols.map((c) => `${c} LIKE ? ESCAPE '\\'`).join(' OR ')})`);
    params.push(...cols.map(() => like));
  }
  if (before) {
    where.push('id < ?');
    params.push(Number(before));
  }
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

export function queryEvents(filters = {}, limit = 50) {
  const { sql, params } = buildWhere(filters);
  const rows = db.prepare(`SELECT * FROM events ${sql} ORDER BY id DESC LIMIT ?`).all(...params, limit + 1);
  const hasMore = rows.length > limit;
  return { events: rows.slice(0, limit).map(toEvent), hasMore };
}

export function countEvents(filters = {}) {
  const { sql, params } = buildWhere({ ...filters, before: undefined });
  return db.prepare(`SELECT COUNT(*) AS n FROM events ${sql}`).get(...params).n;
}

export function eventGroups() {
  return db
    .prepare('SELECT DISTINCT group_name AS g FROM events WHERE group_name IS NOT NULL ORDER BY group_name')
    .all()
    .map((r) => r.g);
}

export function getStats() {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const r = db
    .prepare(
      `SELECT
         COALESCE(SUM(outcome IN ('deleted', 'kicked')), 0) AS deleted,
         COALESCE(SUM(outcome = 'kicked'), 0) AS kicked,
         COALESCE(SUM(outcome IN ('deleted', 'kicked') AND at >= ?), 0) AS today,
         MAX(CASE WHEN outcome IN ('deleted', 'kicked') THEN at END) AS lastActionAt,
         MIN(at) AS since
       FROM events`,
    )
    .get(midnight.toISOString());
  return { deleted: r.deleted, kicked: r.kicked, today: r.today, lastActionAt: r.lastActionAt, since: r.since };
}

export function createSession(tokenHash, createdAt, expiresAt) {
  db.prepare('INSERT INTO sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)').run(tokenHash, createdAt, expiresAt);
}

export function sessionExists(tokenHash, now) {
  return Boolean(db.prepare('SELECT 1 FROM sessions WHERE token_hash = ? AND expires_at > ?').get(tokenHash, now));
}

export function deleteSession(tokenHash) {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
}

export function purgeSessions(now) {
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
}
