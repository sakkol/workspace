import QRCode from "qrcode";

const RELAY = import.meta.env.VITE_RELAY_URL as string;
const root = document.getElementById("app")!;
// The ONLY credential lives in this variable. Never persisted anywhere.
let cap: string | null = null;
let timers: number[] = [];

const h = (tag: string, attrs: Record<string, any> = {}, ...kids: (Node | string)[]) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) k === "onclick" ? (e.onclick = v) : e.setAttribute(k === "cls" ? "class" : k, v);
  e.append(...kids); return e;
};
const show = (...n: Node[]) => root.replaceChildren(h("h1", {}, "Sakkol"), ...n);
const clear = () => { timers.forEach(t => clearInterval(t)); timers = []; };
const mmss = (ms: number) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

async function api(path: string, init: RequestInit = {}) {
  const r = await fetch(RELAY + path, {
    ...init, credentials: "omit", cache: "no-store",
    headers: cap ? { Authorization: "Bearer " + cap } : {},
  });
  if (!r.ok) throw Object.assign(new Error("api"), { status: r.status });
  return r.json();
}

function message(text: string, retry = true) {
  clear();
  show(h("p", {}, text), retry ? h("div", { cls: "row" }, h("button", { cls: "pri", onclick: start }, "Try again")) : h("span"));
}

// ---------- shared computer ----------
async function start() {
  clear(); cap = null; show(h("p", { cls: "mut" }, "Preparing secure link…"));
  let tx: { id: string; code: string; exp: number };
  try { tx = await api("/link/start", { method: "POST" }); }
  catch (e: any) { return message(e.status === 429 ? "Too many attempts. Wait a minute and retry." : "Network problem. Check your connection."); }
  const url = `${location.origin}${location.pathname}#/p/${tx.id}`;
  const canvas = document.createElement("canvas");
  await QRCode.toCanvas(canvas, url, { width: 240, margin: 2 });
  const left = h("span", {});
  show(h("div", { cls: "center" },
    h("h2", {}, "Access your workspace"), canvas,
    h("div", { cls: "code" }, tx.code),
    h("p", {}, "Scan with your phone. Confirm the matching code on your phone. Your Google password is never entered on this computer."),
    h("p", { cls: "mut" }, "Expires in ", left)));
  const tick = () => { left.textContent = mmss(tx.exp - Date.now()); };
  tick(); timers.push(window.setInterval(tick, 1000));
  timers.push(window.setInterval(async () => {
    try {
      const { status } = await api("/link/status/" + tx.id);
      if (status === "approved") { clear(); await claim(tx.id); }
      else if (status === "expired") message("This code expired.");
      else if (status === "cancelled") message("Approval was cancelled or Google authorization failed.");
      else if (status === "consumed") message("This link was already used.");
    } catch { /* keep polling */ }
  }, 2000));
}

async function claim(id: string) {
  show(h("p", { cls: "mut" }, "Signing in…"));
  try { const r = await api("/link/claim/" + id, { method: "POST" }); cap = r.cap; workspace(r.exp); }
  catch { message("Could not complete sign-in."); }
}

async function done() {
  clear();
  try { await api("/session/revoke", { method: "POST" }); } catch { /* server TTL is the fallback */ }
  cap = null; start();
}
const expired = () => { cap = null; message("Session expired. Sign in again."); };

async function workspace(expAt: number) {
  clear();
  const left = h("span", {}), unread = h("span", { cls: "mut" });
  const bar = h("div", { cls: "bar" }, h("div", {}, h("strong", {}, "Inbox "), unread, h("div", { cls: "mut" }, "Session ends in ", left)),
    h("button", { cls: "done", onclick: done }, "DONE / SIGN OUT"));
  const list = h("div", {}, h("p", { cls: "mut" }, "Loading…"));
  show(bar, list);
  const tick = () => { const l = expAt - Date.now(); left.textContent = mmss(l); if (l <= 0) expired(); };
  tick(); timers.push(window.setInterval(tick, 1000));
  try {
    const [p, m] = await Promise.all([api("/gmail/profile"), api("/gmail/messages")]);
    unread.textContent = `(${p.unread} unread)`; list.replaceChildren();
    if (!m.messages.length) list.append(h("p", { cls: "mut" }, "Inbox is empty."));
    for (const x of m.messages) list.append(h("div", { cls: "msg" + (x.unread ? " unread" : ""), onclick: () => openMsg(x.id, expAt) },
      h("div", { cls: "from" }, x.from + " · " + x.date), h("div", { cls: "sub" }, x.subject || "(no subject)"), h("div", { cls: "snip" }, x.snippet)));
  } catch (e: any) { e.status === 401 ? expired() : list.replaceChildren(h("p", {}, e.status === 429 ? "Rate limited, wait a moment." : "Gmail is unavailable right now.")); }
}

async function openMsg(id: string, expAt: number) {
  const box = h("div", {}, h("p", { cls: "mut" }, "Loading…"));
  root.replaceChildren(h("div", { cls: "bar" }, h("button", { onclick: () => workspace(expAt) }, "← Inbox"), h("button", { cls: "done", onclick: done }, "DONE / SIGN OUT")), box);
  try {
    const m = await api("/gmail/messages/" + id);
    // textContent only: Gmail content is never parsed as HTML.
    box.replaceChildren(h("h2", {}, m.subject || "(no subject)"), h("div", { cls: "from" }, `From: ${m.from}`), h("div", { cls: "from" }, m.date), h("pre", {}, m.text));
  } catch (e: any) { e.status === 401 ? expired() : box.replaceChildren(h("p", {}, "Could not load message.")); }
}

// ---------- phone ----------
async function phone(id: string, sub: string) {
  if (sub === "done") return show(h("h2", {}, "Connected ✓"), h("p", {}, "Return to the shared computer. You can close this page."));
  if (sub.startsWith("error")) return show(h("h2", {}, "Not connected"), h("p", {}, "Authorization was cancelled, denied, or expired. Start again from the computer."));
  show(h("p", { cls: "mut" }, "Loading…"));
  try {
    const i = await api("/link/info/" + id);
    show(h("h2", {}, "Connect this computer"), h("p", {}, "Does this code match the code shown on the shared computer?"),
      h("div", { cls: "code center" }, i.code),
      h("p", { cls: "mut" }, "Approving continues to Google's own page. Note: Google will list Sakkol as a connected app on your account until you remove it at myaccount.google.com/permissions."),
      h("div", { cls: "row" },
        h("button", { cls: "pri", onclick: async () => {
          try { const c = await api("/link/confirm/" + id, { method: "POST" }); location.href = `${RELAY}/oauth/google?tx=${id}&n=${c.nonce}`; }
          catch { show(h("p", {}, "This request expired.")); } } }, "Yes, it matches"),
        h("button", { onclick: async () => { try { await api("/link/cancel/" + id, { method: "POST" }); } catch {} show(h("p", {}, "Cancelled.")); } }, "No, cancel")));
  } catch { show(h("p", {}, "This request expired or is invalid. Start again from the computer.")); }
}

function route() {
  const m = location.hash.match(/^#\/p\/([\w-]+)\/?(.*)$/);
  if (m) { cap = null; phone(m[1], m[2]); } else start();
}
window.addEventListener("hashchange", route);
route();
