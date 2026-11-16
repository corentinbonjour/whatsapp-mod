import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createAuth } from './auth.js';
import { listGroups, logout, reconnect, refreshGroups, state } from './bot.js';
import { getConfig, sanitize, saveConfig } from './config.js';
import { countEvents, eventGroups, getStats, queryEvents } from './db.js';
import { findSpam } from './filter.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

function eventFilters(q) {
  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  return {
    type: str(q.type),
    q: str(q.q),
    group: str(q.group),
    outcome: str(q.outcome),
    from: str(q.from),
    to: str(q.to),
    before: str(q.before),
  };
}

const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const wrap = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
};

export function createServer() {
  const password = process.env.ADMIN_PASSWORD;
  if (!password) throw new Error('ADMIN_PASSWORD doit être défini');

  const auth = createAuth(password);
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'same-origin',
      'Cache-Control': 'no-store',
    });
    next();
  });
  app.use(express.json({ limit: '1mb' }));
  app.use(auth.guard);
  app.post('/api/auth/login', auth.login);
  app.post('/api/auth/logout', auth.logout);
  app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));

  const status = () => ({ status: state.status, me: state.me });

  app.get('/api/status', (req, res) => res.json(status()));

  app.get('/api/state', (req, res) => {
    res.json({
      ...status(),
      qr: state.qr,
      groups: listGroups(),
      config: getConfig(),
      events: queryEvents({}, 10).events,
      stats: getStats(),
    });
  });

  app.get('/api/events', (req, res) => {
    const filters = eventFilters(req.query);
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const page = queryEvents(filters, limit);
    res.json({ ...page, total: filters.before ? undefined : countEvents(filters) });
  });

  app.get('/api/events/groups', (req, res) => res.json(eventGroups()));

  app.get('/api/events.csv', (req, res) => {
    const { events } = queryEvents(eventFilters(req.query), 100000);
    const cols = ['at', 'type', 'level', 'outcome', 'group', 'sender', 'name', 'reason', 'msg', 'excerpt'];
    const body = [cols.join(';'), ...events.map((e) => cols.map((c) => csvCell(e[c])).join(';'))].join('\r\n');
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="antispam-logs-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(`\ufeff${body}`);
  });

  app.put('/api/config', (req, res) => {
    try {
      res.json(saveConfig(req.body));
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.post('/api/test', (req, res) => {
    try {
      const cfg = sanitize(req.body.config);
      res.json({ reason: findSpam(String(req.body.text || ''), cfg) });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.post('/api/groups/refresh', wrap(async (req, res) => {
    await refreshGroups();
    res.json({ groups: listGroups() });
  }));

  app.post('/api/reconnect', wrap(async (req, res) => {
    try {
      await reconnect();
    } catch (e) {
      e.status = 400;
      throw e;
    }
    res.json({ ok: true });
  }));

  app.post('/api/whatsapp/logout', wrap(async (req, res) => {
    await logout();
    res.json({ ok: true });
  }));

  return app;
}
