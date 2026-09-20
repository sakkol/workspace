import { h, fmtDate, set } from "../../core/dom";
import { api, post, errText, ApiError } from "../../core/api";
import { S, Shell } from "./index";

export async function openMessage(sh: Shell, id: string) {
  sh.pane.replaceChildren(h("p", { cls: "mut" }, "Loading…"));
  let m: any;
  try { m = await api("gmail", "/gmail/messages/" + encodeURIComponent(id)); }
  catch (e) {
    if (e instanceof ApiError && e.status === 401) return;
    return sh.pane.replaceChildren(h("p", { cls: "err" }, errText(e)), h("button", { onclick: sh.showList }, "← Back"));
  }
  const local = S.msgs.find((x) => x.id === id);
  let starred = !!m.starred;
  const status = h("span", { cls: "err" });

  const act = async (label: string, fn: () => Promise<void>, leave = false) => {
    status.textContent = "";
    try { await fn(); if (leave) sh.showList(); else sh.toast(label); } catch (e) { status.textContent = errText(e); }
  };
  const drop = () => { S.msgs = S.msgs.filter((x) => x.id !== id); };

  const starBtn = h("button", {}, starred ? "★ Unstar" : "☆ Star");
  starBtn.onclick = () => act(starred ? "Unstarred" : "Starred", async () => {
    await post("gmail", `/gmail/messages/${encodeURIComponent(id)}/action`, { action: starred ? "unstar" : "star" });
    starred = !starred; if (local) local.starred = starred; starBtn.textContent = starred ? "★ Unstar" : "☆ Star";
  });

  const tools = sh.canWrite ? [
    h("button", { cls: "pri", onclick: () => sh.compose(replyDraft(m)) }, "↩ Reply"),
    starBtn,
    h("button", { onclick: () => act("Archived", async () => { await post("gmail", `/gmail/messages/${encodeURIComponent(id)}/action`, { action: "archive" }); if (S.label === "INBOX") drop(); }, true) }, "Archive"),
    h("button", { onclick: () => act("Marked unread", async () => { await post("gmail", `/gmail/messages/${encodeURIComponent(id)}/action`, { action: "unread" }); if (local) local.unread = true; }, true) }, "Mark unread"),
    h("button", { onclick: () => act("Moved to Trash", async () => { await post("gmail", `/gmail/messages/${encodeURIComponent(id)}/trash`); drop(); }, true) }, "Trash"),
  ] : [];

  // Opening a message marks it read (write sessions only).
  if (sh.canWrite && m.unread) { post("gmail", `/gmail/messages/${encodeURIComponent(id)}/action`, { action: "read" }).then(() => { if (local) local.unread = false; }).catch(() => {}); }

  set(sh.pane,
    h("div", { cls: "row-l wrap" }, h("button", { onclick: sh.showList }, "← Back"), ...tools),
    status,
    h("h2", {}, m.subject || "(no subject)"),
    // Always show the real address: display names are trivial to fake.
    h("div", { cls: "from" }, "From: ", m.from, m.fromAddr && m.fromAddr !== m.from ? ` (address: ${m.fromAddr})` : ""),
    m.to ? h("div", { cls: "from" }, "To: " + m.to) : null,
    m.cc ? h("div", { cls: "from" }, "Cc: " + m.cc) : null,
    h("div", { cls: "from" }, fmtDate(m.date)),
    // Plain text in a <pre>, never parsed as HTML, links are not clickable on purpose.
    h("pre", { cls: "body" }, m.text));
}

function replyDraft(m: any) {
  const subject = /^re:/i.test(m.subject || "") ? m.subject : "Re: " + (m.subject || "");
  const quoted = String(m.text || "").slice(0, 2000).split("\n").map((l: string) => "> " + l).join("\n");
  return { to: m.replyTo || m.fromAddr || "", cc: "", subject, body: `\n\nOn ${m.date}, ${m.from} wrote:\n${quoted}`, replyToId: m.id as string };
}
