"use strict";

const ICONS = {
  shield: '<path d="M12 3 4.5 6v5.5c0 4.6 3.1 8.3 7.5 9.5 4.4-1.2 7.5-4.9 7.5-9.5V6z"/><path d="m9 12 2 2 4-4"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4v5h-5"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4-4"/>',
  x: '<path d="M17 7 7 17M7 7l10 10"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  power: '<path d="M12 3v9"/><path d="M17.7 6.5a8 8 0 1 1-11.4 0"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  alert: '<path d="M12 9v4M12 16.5v.01"/><path d="M10.3 4.2 2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z"/>',
  "user-plus": '<circle cx="9.5" cy="8" r="3.5"/><path d="M3 20c.6-3.4 3.2-5.5 6.5-5.5S15.4 16.6 16 20"/><path d="M19 8v6M16 11h6"/>',
  flask: '<path d="M9.5 3h5M10 3v6l-5.2 9A2 2 0 0 0 6.5 21h11a2 2 0 0 0 1.7-3L14 9V3"/><path d="M7.5 15h9"/>',
  pencil: '<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
  download: '<path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/>',
  "log-out": '<path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4"/><path d="m9 16-4-4 4-4"/><path d="M5 12h11"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
};
document.body.insertAdjacentHTML(
  "afterbegin",
  '<svg width="0" height="0" style="position:absolute" aria-hidden="true">' +
    Object.entries(ICONS).map(([k, v]) => `<symbol id="i-${k}" viewBox="0 0 24 24">${v}</symbol>`).join("") +
    "</svg>",
);

const $ = (id) => document.getElementById(id);
const nf = new Intl.NumberFormat("fr-FR");

function h(tag, props, ...kids) {
  const n = document.createElement(tag);
  if (props) for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) n.append(c);
  return n;
}

function icon(name) {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("class", "i");
  const u = document.createElementNS("http://www.w3.org/2000/svg", "use");
  u.setAttribute("href", "#i-" + name);
  s.append(u);
  return s;
}

async function api(method, url, body) {
  const headers = { "X-Requested-With": "fetch" };
  if (body) headers["Content-Type"] = "application/json";
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, credentials: "same-origin" });
  if (res.status === 401 && location.pathname !== "/login") {
    location.replace("/login?next=" + encodeURIComponent(location.pathname + location.search));
    throw new Error("Session expirée");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Erreur " + res.status);
  return data;
}

function toast(msg, kind = "ok") {
  let box = $("toasts");
  if (!box) { box = h("div", { id: "toasts", class: "toasts", "aria-live": "polite" }); document.body.append(box); }
  const t = h("div", { class: "toast glass " + kind, role: kind === "err" ? "alert" : "status" }, icon(kind === "err" ? "alert" : "check"), h("span", { text: msg }));
  box.append(t);
  setTimeout(() => t.remove(), kind === "err" ? 6000 : 3000);
}

const sameDay = (a, b) => a.toDateString() === b.toDateString();

function timeAgo(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso)) / 1000);
  if (s < 60) return "à l'instant";
  if (s < 3600) return "il y a " + Math.floor(s / 60) + " min";
  if (s < 86400) return "il y a " + Math.floor(s / 3600) + " h";
  return "il y a " + Math.floor(s / 86400) + " j";
}

function timeOf(iso) {
  return new Date(iso).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function clock(iso) {
  const d = new Date(iso);
  if (sameDay(d, new Date())) return timeOf(iso);
  return d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" }) + " " + d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}

function dayLabel(iso) {
  const d = new Date(iso);
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(d, now)) return "Aujourd'hui";
  if (sameDay(d, yesterday)) return "Hier";
  return d.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" });
}

function formatPhone(d) {
  if (!d) return "";
  if (/^33\d{9}$/.test(d)) return "+33 " + d.slice(2, 3) + " " + d.slice(3).replace(/(\d{2})(?=\d)/g, "$1 ");
  return /^\d+$/.test(d) ? "+" + d : d;
}

function normPhone(v) {
  let d = String(v || "").replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  else if (/^0[1-9]\d{8}$/.test(d)) d = "33" + d.slice(1);
  return d;
}

const OUTCOME = {
  deleted: ["bad", "Supprimé"],
  kicked: ["bad", "Exclu"],
  whitelist: ["", "Whitelist"],
  admin: ["", "Admin"],
  "not-admin": ["warn", "Bot non admin"],
};
const LEVEL = { warn: ["warn", "Avertissement"], error: ["bad", "Erreur"] };

function eventRow(e, opts = {}) {
  const time = h("time", { datetime: e.at, title: new Date(e.at).toLocaleString("fr-FR"), text: opts.timeOnly ? timeOf(e.at) : clock(e.at) });
  const lvl = e.level === "warn" || e.level === "error" ? " lvl-" + e.level : "";
  if (e.type !== "spam") {
    const [cls, label] = LEVEL[e.level] || [];
    return h("div", { class: "event sys" + lvl }, time,
      h("div", { class: "line" }, label ? h("span", { class: "tag " + cls, text: label }) : null, h("span", { class: "msg", text: e.msg })),
      h("span"));
  }
  const [cls, label] = OUTCOME[e.outcome] || ["", e.outcome];
  const excerpt = h("div", { class: "excerpt", text: e.excerpt || "", title: "Afficher tout" });
  excerpt.addEventListener("click", () => excerpt.classList.toggle("open"));
  const number = normPhone(e.sender) || e.sender;
  const action = opts.onWhitelist && e.outcome !== "whitelist" && !opts.isWhitelisted?.(number)
    ? h("button", { class: "btn ghost sm", type: "button", title: "Ne plus filtrer ce numéro", onclick: () => opts.onWhitelist(number) }, icon("user-plus"), "Whitelister")
    : h("span");
  return h("div", { class: "event" + lvl },
    time,
    h("div", {},
      h("div", { class: "line" },
        h("span", { class: "tag " + cls, text: label }),
        h("span", { class: "who", text: e.name || formatPhone(number) }),
        e.name ? h("span", { class: "where", text: formatPhone(number) }) : null,
        h("span", { class: "where", text: "dans " + e.group }),
        e.reason ? h("span", { class: "tag reason", text: e.reason, title: e.reason }) : null,
      ),
      excerpt,
    ),
    action,
  );
}

const STATUS = {
  open: ["ok", "Connecté"],
  qr: ["wait", "En attente du scan"],
  connecting: ["wait", "Connexion"],
  starting: ["wait", "Démarrage"],
  stopped: ["bad", "Arrêté"],
};

function renderStatusChip(s) {
  const chip = $("status");
  if (!s) {
    chip.className = "chip bad";
    chip.querySelector(".label").textContent = "Serveur injoignable";
    return;
  }
  const [cls, label] = STATUS[s.status] || ["bad", s.status];
  chip.className = "chip " + cls;
  chip.querySelector(".label").textContent = s.status === "open" && s.me ? label + " · " + formatPhone(s.me.id.split("@")[0]) : label;
  chip.title = s.status === "stopped" ? "Session prise par un autre appareil ou refusée par WhatsApp" : "";
}

function segmented(el, onPick) {
  el.addEventListener("click", (ev) => {
    const b = ev.target.closest("button[data-v]");
    if (!b) return;
    for (const x of el.children) x.setAttribute("aria-pressed", String(x === b));
    onPick(b.dataset.v);
  });
}

function every(ms, fn) {
  fn();
  setInterval(() => { if (!document.hidden) fn(); }, ms);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) fn(); });
}

const signOutBtn = $("signOutBtn");
if (signOutBtn) {
  signOutBtn.addEventListener("click", async () => {
    try { await api("POST", "/api/auth/logout"); } catch {}
    location.replace("/login");
  });
}
