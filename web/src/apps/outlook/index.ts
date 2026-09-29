import { api, post } from "../../core/api";
import { registerWiper } from "../../core/state";
import { freshState, MailAdapter, MailAction, TFull, TMsg } from "../mail/adapter";
import { mountMail } from "../mail/ui";

// In-memory only. Wiped when Outlook is locked, expires, or the page is closed.
const state = freshState("inbox");
const ACTION: Record<MailAction, string> = { read: "read", unread: "unread", mark: "flag", unmark: "unflag", archive: "archive" };
const base = (id: string) => `/outlook/conversations/${encodeURIComponent(id)}`;

export const outlookAdapter: MailAdapter = {
  app: "outlook", name: "Outlook", icon: "📧",
  // Plain Inbox (no Focused/Other tabs, owner's choice). Folder names are Graph well-known names, whitelisted on the Relay.
  tabs: [["inbox", "Inbox"]], folders: [["sentitems", "Sent"], ["archive", "Archive"], ["deleteditems", "Deleted Items"], ["junkemail", "Junk"]],
  inbox: new Set(["inbox"]),
  markLabel: ["Flag", "Unflag", "Flagged", "Unflagged"],
  searchable: false, // not in the v3 spec (Graph $search cannot be combined with the ordering we rely on)
  simpleReply: true, state,
  wipe() { Object.assign(state, freshState("inbox")); },
  async list(label, _q, more) {
    const qs = new URLSearchParams({ folder: label });
    if (more) qs.set("pageToken", more);
    const r = await api("outlook", "/outlook/conversations?" + qs);
    return { threads: r.threads, next: r.nextPageToken };
  },
  async unreadCount() { return (await api("outlook", "/outlook/profile")).unread; },
  open: (id) => api("outlook", base(id)) as Promise<TFull>,
  async act(id, a) { await post("outlook", base(id) + "/action", { action: ACTION[a] }); },
  async trash(id, folder) { await post("outlook", base(id) + "/trash", { folder }); }, // moves to Deleted Items; never a permanent delete
  async send(o) {
    if (o.replyToId) await post("outlook", `/outlook/messages/${encodeURIComponent(o.replyToId)}/reply`, { comment: o.body }); // recipients: chosen by Outlook
    else await post("outlook", "/outlook/send", { to: o.to, cc: o.cc, subject: o.subject, body: o.body });
  },
  replyDraft(t: TFull, last: TMsg) {
    const subject = /^re:/i.test(t.subject || "") ? t.subject : "Re: " + (t.subject || "");
    return { to: "", cc: "", subject, body: "", replyToId: last.id, replyHint: last.replyHint || last.replyTo || last.fromAddr };
  },
};
registerWiper("outlook", outlookAdapter.wipe);
export const mountOutlook = (root: HTMLElement) => mountMail(root, outlookAdapter);
