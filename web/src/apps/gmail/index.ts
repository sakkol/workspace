import { h, mmss, fmtDate, set } from "../../core/dom";
import { api, lockApp, errText, ApiError } from "../../core/api";
import { caps, every, go, registerWiper } from "../../core/state";
import { openThread } from "./reader";
import { composeView, Draft } from "./compose";

/** One row of the conversation list. */
export interface Thread { id: string; subject: string; senders: string[]; count: number; date: string; snippet: string; unread: boolean; starred: boolean }

// In-memory only. Wiped when Gmail is locked, expires, or the page is closed.
export const S = { label: "INBOX", q: "", threads: [] as Thread[], next: null as string | null, unread: null as number | null };
export const wipeGmail = () => { S.label = "INBOX"; S.q = ""; S.threads = []; S.next = null; S.unread = null; };
registerWiper("gmail", wipeGmail);

const TABS: Array<[string, string]> = [["INBOX", "Inbox"], ["PROMOTIONS", "Promotions"], ["UPDATES", "Updates"]];
const FOLDERS: Array<[string, string]> = [["STARRED", "Starred"], ["SENT", "Sent"], ["TRASH", "Trash"], ["ALL", "All mail"]];
export const IN_INBOX = new Set(TABS.map(([id]) => id)); // archiving removes a conversation from these lists

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
  const pick = (id: string) => { S.label = id; S.threads = []; S.next = null; renderList(); void load(false); };
  const tabBtns = new Map<string, HTMLElement>();
  const tabs = h("div", { cls: "tabs", role: "tablist" }, ...TABS.map(([id, name]) => {
    const b = h("button", { cls: "tab", role: "tab", onclick: () => pick(id) }, name);
    tabBtns.set(id, b);
    return b;
  }));
  const folderBtns = new Map<string, HTMLElement>();
  const nav = h("nav", { cls: "nav" },
    canWrite ? h("button", { cls: "pri wide", onclick: () => shell.compose() }, "✏ Compose") : h("div", { cls: "mut small" }, "Read-only session"),
    ...FOLDERS.map(([id, name]) => {
      const b = h("button", { cls: "navb", onclick: () => pick(id) }, name);
      folderBtns.set(id, b);
      return b;
    }));
  const search = h("input", { type: "search", placeholder: "Search mail…", "aria-label": "Search mail", autocomplete: "off", maxlength: "200" });
  search.onkeydown = (e) => { if (e.key === "Enter") { S.q = search.value.trim(); S.threads = []; S.next = null; renderList(); void load(false); } };

  set(root,
    h("div", { cls: "bar" },
      h("div", {}, h("strong", {}, "✉️ Gmail "), h("span", { cls: "badge" }, canWrite ? "read & write" : "read only"), " ", unreadEl,
        h("div", { cls: "mut small" }, "Session ends in ", cd)),
      h("div", { cls: "row-r" }, h("button", { onclick: () => go({ n: "launcher" }) }, "Apps"),
        h("button", { cls: "done", onclick: async () => { await lockApp("gmail"); go({ n: "launcher" }); } }, "DONE — lock Gmail"))),
    toastEl,
    h("div", { cls: "mail" }, nav, h("div", { cls: "main" }, tabs, search, pane)));

  let loading = false, error = "";
  function renderList() {
    tabBtns.forEach((b, id) => { const on = id === S.label; b.classList.toggle("active", on); b.setAttribute("aria-selected", String(on)); });
    folderBtns.forEach((b, id) => b.classList.toggle("active", id === S.label));
    const folder = FOLDERS.find(([id]) => id === S.label);
    const rows = S.threads.map((t) => h("div", { cls: "msg" + (t.unread ? " unread" : ""), role: "button", tabindex: "0",
      onclick: () => void openThread(shell, t.id), onkeydown: (e: KeyboardEvent) => { if (e.key === "Enter") void openThread(shell, t.id); } },
      h("div", { cls: "from" }, (t.starred ? "★ " : "") + (t.senders.join(", ") || "(unknown sender)") + (t.count > 1 ? ` (${t.count})` : "") + " · " + fmtDate(t.date)),
      h("div", { cls: "sub" }, t.subject || "(no subject)"),
      h("div", { cls: "snip" }, t.snippet)));
    set(pane,
      folder ? h("h3", { cls: "folder" }, folder[1]) : null,
      ...(error ? [h("p", { cls: "err", role: "alert" }, error)] : []),
      ...rows,
      loading ? h("p", { cls: "mut" }, "Loading…") : !S.threads.length && !error ? h("p", { cls: "mut" }, S.q ? "No conversations match your search." : "Nothing here.") : null,
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
      const [r, p] = await Promise.all([api("gmail", "/gmail/threads?" + qs), S.unread === null ? api("gmail", "/gmail/profile") : Promise.resolve(null)]);
      S.threads = more ? [...S.threads, ...r.threads] : r.threads; S.next = r.nextPageToken;
      if (p) S.unread = p.unread;
    } catch (e) { if (!(e instanceof ApiError && e.status === 401)) error = errText(e); }
    loading = false;
    if (caps.has("gmail")) renderList();
  }

  renderList();
  if (S.threads.length === 0) void load(false);
}
