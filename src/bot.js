import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  areJidsSameUser,
  fetchLatestWaWebVersion,
  isJidGroup,
  jidNormalizedUser,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import { DATA_DIR, getConfig } from './config.js';
import { addEvent } from './db.js';
import { extractText, findSpam } from './filter.js';
import { pictureVersion, syncPictures } from './pictures.js';

const AUTH_DIR = path.join(DATA_DIR, 'auth');
const GROUPS_FILE = path.join(DATA_DIR, 'groups.json');
const ACTION_GAP_MS = 1500;
const KICK_MEMORY_MS = 10 * 60 * 1000;
const REFUSED_MAX_RETRIES = 2;
const logger = pino({ level: process.env.BAILEYS_LOG_LEVEL || 'warn' });

export const state = { status: 'starting', qr: null, me: null, groups: loadGroups() };

let sock;
let reconnectTimer;
let reconnectAttempt = 0;
let refusedRetries = 0;
let saveTimer;
let actionQueue = Promise.resolve();
let lastActionAt = 0;
const recentKicks = new Map();

export function log(msg, extra = {}, level = 'info') {
  const entry = { at: new Date().toISOString(), msg, level, ...extra };
  (level === 'error' ? console.error : console.log)(`[${entry.at}] [${level}] ${msg}`);
  try {
    addEvent(entry);
  } catch (e) {
    console.error(`Impossible d'écrire le log en base: ${e.message}`);
  }
}

function loadGroups() {
  try {
    return new Map(Object.entries(JSON.parse(fs.readFileSync(GROUPS_FILE, 'utf8'))));
  } catch {
    return new Map();
  }
}

function saveGroupsSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(`${GROUPS_FILE}.tmp`, JSON.stringify(Object.fromEntries(state.groups)));
      fs.renameSync(`${GROUPS_FILE}.tmp`, GROUPS_FILE);
    } catch (e) {
      log(`Erreur sauvegarde des groupes: ${e.message}`, {}, 'error');
    }
  }, 5000);
}

const userPart = (jid = '') => jid.split('@')[0].split(':')[0];
const digits = (s = '') => s.replace(/\D/g, '');
const idsOf = (p) => [p.id, p.lid, p.phoneNumber].filter(Boolean);

function findParticipant(meta, ids) {
  return meta?.participants?.find((p) => idsOf(p).some((x) => ids.some((id) => areJidsSameUser(x, id))));
}

function botParticipant(meta) {
  if (!state.me) return undefined;
  return findParticipant(meta, [state.me.id, state.me.lid].filter(Boolean));
}

export function listGroups() {
  const enabled = new Set(getConfig().enabledGroups);
  return [...state.groups.values()]
    .map((g) => ({
      id: g.id,
      subject: g.subject || g.id,
      size: g.participants?.length || 0,
      botAdmin: Boolean(botParticipant(g)?.admin),
      enabled: enabled.has(g.id),
      picture: pictureVersion(g.id),
    }))
    .sort((a, b) => a.subject.localeCompare(b.subject, 'fr'));
}

export async function refreshGroups() {
  if (!sock || state.status !== 'open') throw new Error("WhatsApp n'est pas connecté");
  const all = await sock.groupFetchAllParticipating();
  state.groups = new Map(Object.entries(all));
  saveGroupsSoon();
  syncPictures(() => (state.status === 'open' ? sock : null), [...state.groups.keys()], log).catch((e) =>
    log(`Erreur chargement des photos de groupe: ${e.message}`, {}, 'error'),
  );
}

function onGroupsUpsert(list) {
  for (const g of list) state.groups.set(g.id, g);
  saveGroupsSoon();
}

function onGroupsUpdate(list) {
  for (const u of list) {
    const g = state.groups.get(u.id);
    if (g) Object.assign(g, u);
  }
  saveGroupsSoon();
}

function onParticipantsUpdate({ id, participants, action }) {
  const g = state.groups.get(id);
  if (!g?.participants) return;
  for (const p of participants) {
    const i = g.participants.findIndex((x) => idsOf(p).some((a) => idsOf(x).some((b) => areJidsSameUser(a, b))));
    if (action === 'add' && i < 0) g.participants.push({ ...p, admin: p.admin ?? null });
    else if (action === 'remove' && i >= 0) g.participants.splice(i, 1);
    else if (action === 'promote' && i >= 0) g.participants[i].admin = 'admin';
    else if (action === 'demote' && i >= 0) g.participants[i].admin = null;
  }
  saveGroupsSoon();
}

async function getGroup(jid) {
  let meta = state.groups.get(jid);
  if (!meta) {
    meta = await sock.groupMetadata(jid);
    state.groups.set(jid, meta);
    saveGroupsSoon();
  }
  return meta;
}

function enqueueAction(fn) {
  const run = actionQueue.then(async () => {
    const wait = lastActionAt + ACTION_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    try {
      return await fn();
    } finally {
      lastActionAt = Date.now();
    }
  });
  actionQueue = run.catch(() => {});
  return run;
}

async function handleMessage(m) {
  const jid = m.key.remoteJid;
  if (!isJidGroup(jid) || m.key.fromMe || !m.message) return;
  const cfg = getConfig();
  if (!cfg.enabledGroups.includes(jid)) return;

  const text = extractText(m.message);
  if (!text) return;
  const reason = findSpam(text, cfg);
  if (!reason) return;

  const sender = m.key.participant;
  const meta = await getGroup(jid);
  const p = findParticipant(meta, [sender]);
  const ids = [sender, m.key.participantAlt, ...(p ? idsOf(p) : [])].filter(Boolean);
  const phone = ids.find((id) => id.endsWith('@s.whatsapp.net'));
  const base = {
    type: 'spam',
    groupId: jid,
    group: meta?.subject || jid,
    sender: phone ? userPart(phone) : userPart(sender),
    name: m.pushName || '',
    reason,
    excerpt: text.slice(0, 200),
  };

  const wl = cfg.whitelist.map(digits).filter(Boolean);
  if (ids.some((id) => wl.includes(digits(userPart(id))))) {
    log(`Ignoré (whitelist): ${base.sender} dans ${base.group}`, { ...base, outcome: 'whitelist' });
    return;
  }
  if (cfg.ignoreAdmins && p?.admin) {
    log(`Ignoré (admin): ${base.sender} dans ${base.group}`, { ...base, outcome: 'admin' });
    return;
  }
  if (!botParticipant(meta)?.admin) {
    log(`Spam détecté mais le bot n'est pas admin de ${base.group}`, { ...base, outcome: 'not-admin' }, 'warn');
    return;
  }

  await enqueueAction(() => sock.sendMessage(jid, { delete: m.key }));
  let outcome = 'deleted';

  const kickKey = `${jid}|${userPart(sender)}`;
  const now = Date.now();
  for (const [k, at] of recentKicks) if (now - at > KICK_MEMORY_MS) recentKicks.delete(k);
  if (cfg.action === 'kick' && !recentKicks.has(kickKey)) {
    recentKicks.set(kickKey, now);
    await enqueueAction(() => sock.groupParticipantsUpdate(jid, [sender], 'remove'));
    outcome = 'kicked';
  }
  log(`${outcome === 'kicked' ? 'Supprimé et exclu' : 'Supprimé'}: ${base.sender} dans ${base.group} (${reason})`, {
    ...base,
    outcome,
  });
}

function scheduleReconnect(delayMs) {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    start().catch((e) => {
      log(`Erreur démarrage: ${e.message}`, {}, 'error');
      scheduleReconnect(nextBackoff());
    });
  }, delayMs);
}

function nextBackoff() {
  reconnectAttempt += 1;
  return Math.min(3000 * 2 ** (reconnectAttempt - 1), 5 * 60 * 1000);
}

export async function start() {
  clearTimeout(reconnectTimer);
  state.status = 'connecting';
  const { state: auth, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestWaWebVersion().catch(() => ({}));

  const current = makeWASocket({
    auth,
    logger,
    ...(version ? { version } : {}),
    browser: Browsers.ubuntu('whatsapp-mod'),
    markOnlineOnConnect: false,
    syncFullHistory: false,
    cachedGroupMetadata: async (jid) => state.groups.get(jid),
  });
  sock = current;

  current.ev.on('creds.update', saveCreds);

  current.ev.on('connection.update', async (u) => {
    if (current !== sock) return;
    if (u.qr) {
      state.status = 'qr';
      state.qr = await QRCode.toDataURL(u.qr, { margin: 1, width: 320 });
      console.log(await QRCode.toString(u.qr, { type: 'terminal', small: true }));
    }
    if (u.connection === 'open') {
      reconnectAttempt = 0;
      refusedRetries = 0;
      state.status = 'open';
      state.qr = null;
      state.me = {
        id: jidNormalizedUser(current.user.id),
        lid: current.user.lid ? jidNormalizedUser(current.user.lid) : null,
        name: current.user.name || '',
      };
      log(`Connecté en tant que ${userPart(state.me.id)}`);
      if (!state.groups.size) log('Aucun groupe en mémoire, clique sur Actualiser pour charger la liste');
    }
    if (u.connection === 'close') {
      const code = u.lastDisconnect?.error?.output?.statusCode;
      state.qr = null;
      if (code === DisconnectReason.connectionReplaced || code === DisconnectReason.forbidden) {
        if (refusedRetries < REFUSED_MAX_RETRIES) {
          refusedRetries += 1;
          state.status = 'connecting';
          log(`Connexion fermée par WhatsApp (code ${code}), essai ${refusedRetries}/${REFUSED_MAX_RETRIES} dans 10 s`, {}, 'warn');
          scheduleReconnect(10000);
        } else {
          state.status = 'stopped';
          log(`Connexion fermée par WhatsApp (code ${code}), arrêt après ${REFUSED_MAX_RETRIES} essais`, {}, 'error');
        }
        return;
      }
      state.status = 'connecting';
      if (code === DisconnectReason.loggedOut) {
        log('Session fermée par WhatsApp, un nouveau QR va être généré', {}, 'warn');
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        state.me = null;
        state.groups.clear();
        saveGroupsSoon();
        scheduleReconnect(1000);
      } else if (code === DisconnectReason.restartRequired) {
        scheduleReconnect(1000);
      } else {
        const delay = nextBackoff();
        log(`Connexion fermée (code ${code ?? 'inconnu'}), reconnexion dans ${Math.round(delay / 1000)} s`, {}, 'warn');
        scheduleReconnect(delay);
      }
    }
  });

  current.ev.on('messages.upsert', ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const m of messages) {
      handleMessage(m).catch((e) => log(`Erreur traitement message: ${e.message}`, {}, 'error'));
    }
  });

  current.ev.on('groups.upsert', onGroupsUpsert);
  current.ev.on('groups.update', onGroupsUpdate);
  current.ev.on('group-participants.update', onParticipantsUpdate);
}

export async function reconnect() {
  if (state.status !== 'stopped') throw new Error('Le bot est déjà connecté ou en cours de connexion');
  reconnectAttempt = 0;
  refusedRetries = 0;
  await start();
}

export async function logout() {
  if (sock) await sock.logout();
}
