import fs from 'node:fs';
import path from 'node:path';
import { compilePattern } from './filter.js';

export const DATA_DIR = path.resolve(process.env.DATA_DIR || 'data');
const FILE = path.join(DATA_DIR, 'config.json');

const DEFAULTS = {
  enabledGroups: [],
  patterns: [],
  blockInviteLinks: true,
  action: 'delete',
  ignoreAdmins: true,
  whitelist: [],
};

function load() {
  try {
    return sanitize({ ...DEFAULTS, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) });
  } catch (e) {
    if (e.code !== 'ENOENT') console.error(`config.json illisible, valeurs par défaut utilisées: ${e.message}`);
    return structuredClone(DEFAULTS);
  }
}

const strList = (v) =>
  Array.isArray(v) ? [...new Set(v.map((s) => String(s).trim()).filter(Boolean))] : [];

export function sanitize(c = {}) {
  const patterns = strList(c.patterns);
  for (const p of patterns) {
    try {
      compilePattern(p);
    } catch {
      throw new Error(`Regex invalide: ${p}`);
    }
  }
  return {
    enabledGroups: strList(c.enabledGroups).filter((j) => j.endsWith('@g.us')),
    patterns,
    blockInviteLinks: c.blockInviteLinks !== false,
    action: c.action === 'kick' ? 'kick' : 'delete',
    ignoreAdmins: c.ignoreAdmins !== false,
    whitelist: strList(c.whitelist),
  };
}

let current = load();

export const getConfig = () => current;

export function saveConfig(input) {
  const next = sanitize(input);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(`${FILE}.tmp`, JSON.stringify(next, null, 2));
  fs.renameSync(`${FILE}.tmp`, FILE);
  current = next;
  return next;
}
