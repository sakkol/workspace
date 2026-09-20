import { h, mmss, fmtDate, set } from "../../core/dom";
import { api, post, lockApp, errText, ApiError } from "../../core/api";
import { caps, every, go, registerWiper } from "../../core/state";
import { openMessage } from "./reader";
import { composeView, Draft } from "./compose";

export interface Msg { id: string; from: string; subject: string; date: string; snippet: string; unread: boolean; starred: boolean }

// In-memory only. Wiped when Gmail is locked, expires, or the page is closed.
export const S = { label: "INBOX", q: "", msgs: [] as Msg[], next: null as string | null, unread: null as number | null };
export const wipeGmail = () => { S.label = "INBOX"; S.q = ""; S.msgs = []; S.next = null; S.unread = null; };
registerWiper("gmail", wipeGmail);

const LABELS: Array<[string, string]> = [["INBOX", "Inbox"], ["STARRED", "Starred"], ["SENT", "Sent"], ["TRASH", "Trash"], ["ALL", "All mail"]];

export interface Shell { pane: HTMLElement; showList(): void; compose(d?: Draft): void; canWrite: boolean; toast(t: string): void }

export function mountGmail(root: HTMLElement) {
  const cap = caps.get("gmail")!;
  const canWrite = cap.access === "write";
  const cd = h("span");
  const tick = () => { cd.textContent = mmss(cap.expAt - Date.now()); };
  tick(); every(tick, 1000);

  const pane = h("div", { cls: "pane" });
  const toastEl = h("div", { cls: "toast", role: "status" });
  const shell: Shell = {
    pane, canWrite,
    showList: () => renderList(),
    compose: (d) => composeView(shell, d),
    toast: (t) => { toastEl.textContent = t; setTimeout(() => { if (toastEl.textContent === t) toastEl.textContent = ""; }, 4000); },
  };

  const unreadEl = h("span", { cls: "mut" });
  const navBtns = new Map<string, HTMLElement>();
  const nav = h("nav", { cls: "nav" },
    canWrite ? h("button", { cls: "pri wide", onclick: () => shell.compose() }, "✏ Compose") : h("div", { cls: "mut small" }, "Read-only session"),
    ...LABELS.map(([id, name]) => {
      const b = h("button", { cls: "navb", onclick: () => { S.label = id; S.msgs = []; S.next = null; renderList(); void load(false); } }, name);
      navBtns.set(id, b);
      return b;
    }));
  const search = h("input", { type: "search", placeholder: "Search mail…", "aria-label": "Search mail", autocomplete: "off", maxlength: "200" });
  search.onkeydown = (e) => { if (e.key === "Enter") { S.q = search.value.trim(); S.msgs = []; S.next = null; renderList(); void load(false); } };

  root.replaceChildren(
    h("div", { cls: "bar" },
      h("div", {}, h("strong", {}, "✉️ Gmail "), h("span", { cls: "badge" }, canWrite ? "read & write" : "read only"), " ", unreadEl,
        h("div", { cls: "mut small" }, "Session ends in ", cd)),
      h("div", { cls: "row-r" }, h("button", { onclick: () => go({ n: "launcher" }) }, "Apps"),
        h("button", { cls: "done", onclick: async () => { await lockApp("gmail"); go({ n: "launcher" }); } }, "DONE — lock Gmail"))),
    toastEl,
    h("div", { cls: "mail" }, nav, h("div", { cls: "main" }, search, pane)));

  let loading = false, error = "";
  function renderList() {
    navBtns.forEach((b, id) => b.classList.toggle("active", id === S.label));
    const rows = S.msgs.map((m) => h("div", { cls: "msg" + (m.unread ? " unread" : ""), role: "button", tabindex: "0",
      onclick: () => openMessage(shell, m.id), onkeydown: (e: KeyboardEvent) => { if (e.key === "Enter") openMessage(shell, m.id); } },
      h("div", { cls: "from" }, (m.starred ? "★ " : "") + (m.from || "(unknown sender)") + " · " + fmtDate(m.date)),
      h("div", { cls: "sub" }, m.subject || "(no subject)"),
      h("div", { cls: "snip" }, m.snippet)));
    set(pane,
      ...(error ? [h("p", { cls: "err", role: "alert" }, error)] : []),
      ...rows,
      loading ? h("p", { cls: "mut" }, "Loading…") : !S.msgs.length && !error ? h("p", { cls: "mut" }, S.q ? "No messages match your search." : "Nothing here.") : null,
      S.next && !loading ? h("div", { cls: "row" }, h("button", { onclick: () => void load(true) }, "Load more")) : null);
    unreadEl.textContent = S.unread === null ? "" : `(${S.unread} unread)`;
  }

  async function load(more: boolean) {
    if (loading) return;
    loading = true; error = ""; renderList();
    try {
      const qs = new URLSearchParams({ label: S.label });
      if (S.q) qs.set("q", S.q);
      if (more && S.next) qs.set("pageToken", S.next);
      const [r, p] = await Promise.all([api("gmail", "/gmail/messages?" + qs), S.unread === null ? api("gmail", "/gmail/profile") : Promise.resolve(null)]);
      S.msgs = more ? [...S.msgs, ...r.messages] : r.messages; S.next = r.nextPageToken;
      if (p) S.unread = p.unread;
    } catch (e) { if (!(e instanceof ApiError && e.status === 401)) error = errText(e); }
    loading = false;
    if (caps.has("gmail")) renderList();
  }

  renderList();
  if (S.msgs.length === 0) void load(false);
}

export { post };
