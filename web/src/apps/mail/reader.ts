import { h, fmtDate, set } from "../../core/dom";
import { errText, ApiError } from "../../core/api";
import type { MailAdapter, TFull, TMsg } from "./adapter";
import type { Shell } from "./ui";
import { splitQuoted } from "./quote";

/** Conversation view: every message in the thread, oldest first. */
export async function openThread(sh: Shell, A: MailAdapter, id: string) {
  const S = A.state;
  set(sh.pane, h("p", { cls: "mut" }, "Loading…"));
  let t: TFull;
  try { t = await A.open(id); }
  catch (e) {
    if (e instanceof ApiError && e.status === 401) return;
    return set(sh.pane, h("p", { cls: "err" }, errText(e)), h("button", { onclick: sh.showList }, "← Back"));
  }
  const local = S.threads.find((x) => x.id === id);
  const last = t.messages[t.messages.length - 1];
  const folder = S.label; // the folder the conversation was opened from
  let starred = t.messages.some((m) => m.starred);
  const status = h("span", { cls: "err", role: "alert" });
  const [onLbl, offLbl, doneOn, doneOff] = A.markLabel;

  const act = async (label: string, fn: () => Promise<void>, leave = false) => {
    status.textContent = "";
    try { await fn(); if (leave) sh.showList(); else sh.toast(label); } catch (e) { status.textContent = errText(e); }
  };
  const drop = () => { S.threads = S.threads.filter((x) => x.id !== id); };

  const starBtn = h("button", {}, starred ? "★ " + offLbl : "☆ " + onLbl);
  starBtn.onclick = () => act(starred ? doneOff : doneOn, async () => {
    await A.act(id, starred ? "unmark" : "mark");
    starred = !starred; if (local) local.starred = starred; starBtn.textContent = starred ? "★ " + offLbl : "☆ " + onLbl;
  });

  const replyBtn = () => h("button", { cls: "pri", onclick: () => sh.compose(A.replyDraft(t, last)) }, "↩ Reply");
  const tools = sh.canWrite ? [
    replyBtn(), starBtn,
    h("button", { onclick: () => act("Archived", async () => { await A.act(id, "archive"); if (A.inbox.has(S.label)) drop(); }, true) }, "Archive"),
    h("button", { onclick: () => act("Marked unread", async () => { await A.act(id, "unread"); if (local) local.unread = true; }, true) }, "Mark unread"),
    h("button", { onclick: () => act(A.app === "outlook" ? "Moved to Deleted Items" : "Moved to Trash", async () => { await A.trash(id, folder); drop(); }, true) }, A.app === "outlook" ? "Delete" : "Trash"),
  ] : [];

  // Opening a conversation marks it read (write sessions only).
  if (sh.canWrite && t.messages.some((m) => m.unread)) {
    A.act(id, "read").then(() => { if (local) local.unread = false; }).catch(() => {});
  }

  set(sh.pane,
    h("div", { cls: "row-l wrap" }, h("button", { onclick: sh.showList }, "← Back"), ...tools),
    status,
    h("h2", {}, t.subject || "(no subject)"),
    t.truncated ? h("p", { cls: "mut small" }, `Showing the last ${t.messages.length} of ${t.count} messages.`) : null,
    ...t.messages.map((m, i) => card(m, i === t.messages.length - 1 || m.unread)),
    sh.canWrite ? h("div", { cls: "row-l" }, replyBtn()) : null);
}

/** One message in the chain: collapsed = one line, expanded = headers + text (quoted history folded). */
function card(m: TMsg, expanded: boolean): HTMLElement {
  const el = h("div", { cls: "tm" });
  let open = expanded, showQuoted = false;
  const draw = () => {
    const { main, quoted } = splitQuoted(m.text);
    const who = m.sent ? "me" : m.from.replace(/\s*<[^>]*>\s*$/, "").replace(/^"|"$/g, "") || m.fromAddr;
    const toggle = () => { open = !open; draw(); };
    const head = h("div", { cls: "tmh", role: "button", tabindex: "0", "aria-expanded": String(open), onclick: toggle, onkeydown: (e: KeyboardEvent) => { if (e.key === "Enter") toggle(); } },
      h("strong", {}, who), " ", h("span", { cls: "mut small" }, fmtDate(m.date)),
      open ? null : h("div", { cls: "snip" }, main.replace(/\s+/g, " ").slice(0, 140)));
    if (!open) return set(el, head);
    set(el, head,
      // Always show the real address: display names are trivial to fake.
      h("div", { cls: "from" }, "From: ", m.from.includes(m.fromAddr) ? m.from : `${m.from} (address: ${m.fromAddr})`),
      m.to ? h("div", { cls: "from" }, "To: " + m.to) : null,
      m.cc ? h("div", { cls: "from" }, "Cc: " + m.cc) : null,
      // Plain text in a <pre>, never parsed as HTML. Links are deliberately not clickable.
      h("pre", { cls: "body" }, main),
      quoted ? h("button", { cls: "quotebtn", "aria-label": "Show quoted text", onclick: () => { showQuoted = !showQuoted; draw(); } }, showQuoted ? "Hide quoted text" : "··· Show quoted text") : null,
      quoted && showQuoted ? h("pre", { cls: "body quoted" }, quoted) : null);
  };
  draw();
  return el;
}
