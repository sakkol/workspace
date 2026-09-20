import { h, fmtDate, set } from "../../core/dom";
import { api, post, errText, ApiError } from "../../core/api";
import { S, IN_INBOX, Shell } from "./index";
import { splitQuoted } from "./quote";

interface TMsg { id: string; from: string; fromAddr: string; replyTo: string; to: string; toAddrs: string[]; cc: string; date: string; unread: boolean; starred: boolean; sent: boolean; text: string }
interface TFull { id: string; subject: string; count: number; truncated: boolean; messages: TMsg[] }

/** Conversation view: every message in the thread, oldest first, like the original Gmail. */
export async function openThread(sh: Shell, id: string) {
  set(sh.pane, h("p", { cls: "mut" }, "Loading…"));
  let t: TFull;
  try { t = await api("gmail", "/gmail/threads/" + encodeURIComponent(id)); }
  catch (e) {
    if (e instanceof ApiError && e.status === 401) return;
    return set(sh.pane, h("p", { cls: "err" }, errText(e)), h("button", { onclick: sh.showList }, "← Back"));
  }
  const local = S.threads.find((x) => x.id === id);
  const last = t.messages[t.messages.length - 1];
  let starred = t.messages.some((m) => m.starred);
  const status = h("span", { cls: "err", role: "alert" });
  const base = `/gmail/threads/${encodeURIComponent(id)}`;

  const act = async (label: string, fn: () => Promise<void>, leave = false) => {
    status.textContent = "";
    try { await fn(); if (leave) sh.showList(); else sh.toast(label); } catch (e) { status.textContent = errText(e); }
  };
  const drop = () => { S.threads = S.threads.filter((x) => x.id !== id); };

  const starBtn = h("button", {}, starred ? "★ Unstar" : "☆ Star");
  starBtn.onclick = () => act(starred ? "Unstarred" : "Starred", async () => {
    await post("gmail", base + "/action", { action: starred ? "unstar" : "star" });
    starred = !starred; if (local) local.starred = starred; starBtn.textContent = starred ? "★ Unstar" : "☆ Star";
  });

  const replyBtn = () => h("button", { cls: "pri", onclick: () => sh.compose(replyDraft(t, last)) }, "↩ Reply");
  const tools = sh.canWrite ? [
    replyBtn(), starBtn,
    h("button", { onclick: () => act("Archived", async () => { await post("gmail", base + "/action", { action: "archive" }); if (IN_INBOX.has(S.label)) drop(); }, true) }, "Archive"),
    h("button", { onclick: () => act("Marked unread", async () => { await post("gmail", base + "/action", { action: "unread" }); if (local) local.unread = true; }, true) }, "Mark unread"),
    h("button", { onclick: () => act("Moved to Trash", async () => { await post("gmail", base + "/trash"); drop(); }, true) }, "Trash"),
  ] : [];

  // Opening a conversation marks it read (write sessions only).
  if (sh.canWrite && t.messages.some((m) => m.unread)) {
    post("gmail", base + "/action", { action: "read" }).then(() => { if (local) local.unread = false; }).catch(() => {});
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

function replyDraft(t: TFull, last: TMsg) {
  // Replying to your own message goes to the people you wrote to; otherwise to the sender (or Reply-To).
  const to = last.sent ? last.toAddrs.join(", ") : last.replyTo || last.fromAddr;
  const subject = /^re:/i.test(t.subject || "") ? t.subject : "Re: " + (t.subject || "");
  const quoted = splitQuoted(last.text).main.slice(0, 2000).split("\n").map((l) => "> " + l).join("\n");
  return { to, cc: "", subject, body: `\n\nOn ${last.date}, ${last.from} wrote:\n${quoted}`, replyToId: last.id };
}
