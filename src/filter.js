const INVITE_RE = /chat\.whatsapp\.com\/|whatsapp\.com\/channel\//;

export function normalize(text) {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u200b-\u200f\u2060\ufeff]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function compilePattern(p) {
  const m = p.match(/^\/(.+)\/([a-z]*)$/s);
  if (m) {
    const re = new RegExp(m[1], m[2].includes('i') ? m[2] : `${m[2]}i`);
    return (t) => re.test(t);
  }
  const needle = normalize(p);
  return (t) => t.includes(needle);
}

const compiled = new WeakMap();

function matchersFor(cfg) {
  let list = compiled.get(cfg);
  if (!list) {
    list = cfg.patterns.map((p) => ({ p, test: compilePattern(p) }));
    compiled.set(cfg, list);
  }
  return list;
}

export function findSpam(text, cfg) {
  const t = normalize(text);
  if (cfg.blockInviteLinks && INVITE_RE.test(t.replace(/\s/g, ''))) return "lien d'invitation";
  const hit = matchersFor(cfg).find((m) => m.test(t));
  return hit ? `motif ${hit.p}` : null;
}

const WRAPPERS = [
  'ephemeralMessage',
  'viewOnceMessage',
  'viewOnceMessageV2',
  'viewOnceMessageV2Extension',
  'documentWithCaptionMessage',
  'editedMessage',
];

export function extractText(message) {
  let msg = message;
  for (let i = 0; i < 5 && msg; i++) {
    const key = WRAPPERS.find((k) => msg[k]?.message);
    if (!key) break;
    msg = msg[key].message;
  }
  if (!msg) return '';
  const poll = msg.pollCreationMessage || msg.pollCreationMessageV2 || msg.pollCreationMessageV3;
  return [
    msg.conversation,
    msg.extendedTextMessage?.text,
    msg.imageMessage?.caption,
    msg.videoMessage?.caption,
    msg.documentMessage?.caption,
    msg.documentMessage?.fileName,
    poll?.name,
    ...(poll?.options || []).map((o) => o.optionName),
  ]
    .filter(Boolean)
    .join('\n');
}
