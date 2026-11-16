import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { DATA_DIR } from './config.js';

const DIR = path.join(DATA_DIR, 'pictures');
const INDEX_FILE = path.join(DIR, 'index.json');
const GAP_MS = 2000;
const TTL_MS = 7 * 86400000;
const MAX_BYTES = 2 * 1024 * 1024;
const NO_PICTURE_CODES = new Set([401, 403, 404]);

export const pictureJob = { running: false, done: 0, total: 0 };

let index = loadIndex();

function loadIndex() {
  try {
    return JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveIndex() {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(`${INDEX_FILE}.tmp`, JSON.stringify(index));
  fs.renameSync(`${INDEX_FILE}.tmp`, INDEX_FILE);
}

const fileFor = (jid) => path.join(DIR, `${crypto.createHash('sha1').update(jid).digest('hex')}.jpg`);

export function pictureVersion(jid) {
  const entry = index[jid];
  return entry?.file ? entry.at : null;
}

export function picturePath(jid) {
  return index[jid]?.file ? fileFor(jid) : null;
}

async function download(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error('image trop lourde');
  return buf;
}

export async function syncPictures(getSocket, jids, log) {
  if (pictureJob.running) return;
  const now = Date.now();
  const todo = jids.filter((j) => !index[j] || now - Date.parse(index[j].at) > TTL_MS);
  if (!todo.length) return;

  Object.assign(pictureJob, { running: true, done: 0, total: todo.length });
  try {
    for (const jid of todo) {
      const sock = getSocket();
      if (!sock) break;
      let file = null;
      try {
        const url = await sock.profilePictureUrl(jid, 'preview');
        if (url) {
          fs.mkdirSync(DIR, { recursive: true });
          fs.writeFileSync(fileFor(jid), await download(url));
          file = true;
        } else {
          file = false;
        }
      } catch (e) {
        if (/rate-overlimit/.test(e.message)) {
          log('WhatsApp limite les requêtes, chargement des photos de groupe interrompu', {}, 'warn');
          break;
        }
        if (NO_PICTURE_CODES.has(e.output?.statusCode)) file = false;
      }
      if (file !== null) {
        if (!file) fs.rmSync(fileFor(jid), { force: true });
        index[jid] = { at: new Date().toISOString(), file };
        saveIndex();
      }
      pictureJob.done += 1;
      await sleep(GAP_MS);
    }
  } finally {
    pictureJob.running = false;
  }
}
