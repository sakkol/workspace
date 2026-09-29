import { h, mmss, fmtDate, set } from "../../core/dom";
import { lockApp, errText, ApiError } from "../../core/api";
import { caps, every, go } from "../../core/state";
import type { Draft, MailAdapter } from "./adapter";
import { openThread } from "./reader";
import { composeView } from "./compose";

export interface Shell { pane: HTMLElement; showList(): void; compose(d?: Draft): void; canWrite: boolean; toast(t: string): void }

/** The mail app (Gmail and Outlook). All state lives in `A.state` (memory only) and is wiped when the app is locked. */
export function mountMail(root: HTMLElement, A: MailAdapter) {
  const S = A.state;
  const cap = caps.get(A.app)!;
  const canWrite = cap.access === "write";
  const cd = h("span");
  const tick = () => { cd.textContent = mmss(cap.expAt - Date.now()); };
  tick(); every(tick, 1000);

  const pane = h("div", { cls: "pane" });
  const toastEl = h("div", { cls: "toast", role: "status" });
  const shell: Shell = {
    pane, canWrite,
    showList: () => renderList(),
    compose: (d) => composeView(shell, A, d),
    toast: (t) => { toastEl.textContent = t; setTimeout(() => { if (toastEl.textContent === t) toastEl.textContent = ""; }, 4000); },
  };

  const unreadEl = h("span", { cls: "mut" });
  const pick = (id: string) => { S.label = id; S.threads = []; S.next = null; renderList(); void load(false); };
  const tabBtns = new Map<string, HTMLElement>();
  const tabs = A.tabs.length > 1 ? h("div", { cls: "tabs", role: "tablist" }, ...A.tabs.map(([id, name]) => {
    const b = h("button", { cls: "tab", role: "tab", onclick: () => pick(id) }, name);
    tabBtns.set(id, b);
    return b;
  })) : null;
  const folderBtns = new Map<string, HTMLElement>();
  const nav = h("nav", { cls: "nav" },
    canWrite ? h("button", { cls: "pri wide", onclick: () => shell.compose() }, "✏ Compose") : h("div", { cls: "mut small" }, "Read-only session"),
    ...(A.tabs.length === 1 ? [A.tabs[0]] : []).map(([id, name]) => { const b = h("button", { cls: "navb", onclick: () => pick(id) }, name); folderBtns.set(id, b); return b; }),
    ...A.folders.map(([id, name]) => {
      const b = h("button", { cls: "navb", onclick: () => pick(id) }, name);
      folderBtns.set(id, b);
      return b;
    }));
  const search = h("input", { type: "search", placeholder: "Search mail…", "aria-label": "Search mail", autocomplete: "off", maxlength: "200" });
  search.onkeydown = (e) => { if (e.key === "Enter") { S.q = search.value.trim(); S.threads = []; S.next = null; renderList(); void load(false); } };

  set(root,
    h("div", { cls: "bar" },
      h("div", {}, h("strong", {}, `${A.icon} ${A.name} `), h("span", { cls: "badge" }, canWrite ? "read & write" : "read only"), " ", unreadEl,
        h("div", { cls: "mut small" }, "Session ends in ", cd)),
      h("div", { cls: "row-r" }, h("button", { onclick: () => go({ n: "launcher" }) }, "Apps"),
        h("button", { cls: "done", onclick: async () => { await lockApp(A.app); go({ n: "launcher" }); } }, `DONE — lock ${A.name}`))),
    toastEl,
    h("div", { cls: "mail" }, nav, h("div", { cls: "main" }, tabs, A.searchable ? search : null, pane)));

  let loading = false, error = "";
  function renderList() {
    tabBtns.forEach((b, id) => { const on = id === S.label; b.classList.toggle("active", on); b.setAttribute("aria-selected", String(on)); });
    folderBtns.forEach((b, id) => b.classList.toggle("active", id === S.label));
    const folder = A.folders.find(([id]) => id === S.label);
    const rows = S.threads.map((t) => h("div", { cls: "msg" + (t.unread ? " unread" : ""), role: "button", tabindex: "0",
      onclick: () => void openThread(shell, A, t.id), onkeydown: (e: KeyboardEvent) => { if (e.key === "Enter") void openThread(shell, A, t.id); } },
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
      const [r, n] = await Promise.all([A.list(S.label, S.q, more ? S.next : null), S.unread === null ? A.unreadCount() : Promise.resolve(null)]);
      S.threads = more ? [...S.threads, ...r.threads.filter((t) => !S.threads.some((x) => x.id === t.id))] : r.threads; S.next = r.next;
      if (n !== null) S.unread = n;
    } catch (e) { if (!(e instanceof ApiError && e.status === 401)) error = errText(e); }
    loading = false;
    if (caps.has(A.app)) renderList();
  }

  renderList();
  if (S.threads.length === 0) void load(false);
}
