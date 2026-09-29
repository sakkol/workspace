import { api, post } from "../../core/api";
import { registerWiper } from "../../core/state";
import { freshState, MailAdapter, MailAction, TFull, TMsg } from "../mail/adapter";
import { mountMail } from "../mail/ui";
import { splitQuoted } from "./quote";

// In-memory only. Wiped when Gmail is locked, expires, or the page is closed.
const state = freshState("INBOX");
const TABS: Array<[string, string]> = [["INBOX", "Inbox"], ["PROMOTIONS", "Promotions"], ["UPDATES", "Updates"]];
const ACTION: Record<MailAction, string> = { read: "read", unread: "unread", mark: "star", unmark: "unstar", archive: "archive" };
const base = (id: string) => `/gmail/threads/${encodeURIComponent(id)}`;

export const gmailAdapter: MailAdapter = {
  app: "gmail", name: "Gmail", icon: "✉️",
  tabs: TABS, folders: [["STARRED", "Starred"], ["SENT", "Sent"], ["TRASH", "Trash"], ["ALL", "All mail"]],
  inbox: new Set(TABS.map(([id]) => id)), // archiving removes a conversation from these lists
  markLabel: ["Star", "Unstar", "Starred", "Unstarred"],
  searchable: true, simpleReply: false, state,
  wipe() { Object.assign(state, freshState("INBOX")); },
  async list(label, q, more) {
    const qs = new URLSearchParams({ label });
    if (q) qs.set("q", q);
    if (more) qs.set("pageToken", more);
    const r = await api("gmail", "/gmail/threads?" + qs);
    return { threads: r.threads, next: r.nextPageToken };
  },
  async unreadCount() { return (await api("gmail", "/gmail/profile")).unread; },
  open: (id) => api("gmail", base(id)) as Promise<TFull>,
  async act(id, a) { await post("gmail", base(id) + "/action", { action: ACTION[a] }); },
  async trash(id) { await post("gmail", base(id) + "/trash"); },
  async send(o) { await post("gmail", "/gmail/send", o); },
  replyDraft(t: TFull, last: TMsg) {
    // Replying to your own message goes to the people you wrote to; otherwise to the sender (or Reply-To).
    const to = last.sent ? last.toAddrs.join(", ") : last.replyTo || last.fromAddr;
    const subject = /^re:/i.test(t.subject || "") ? t.subject : "Re: " + (t.subject || "");
    const quoted = splitQuoted(last.text).main.slice(0, 2000).split("\n").map((l) => "> " + l).join("\n");
    return { to, cc: "", subject, body: `\n\nOn ${last.date}, ${last.from} wrote:\n${quoted}`, replyToId: last.id };
  },
};
registerWiper("gmail", gmailAdapter.wipe);
export const mountGmail = (root: HTMLElement) => mountMail(root, gmailAdapter);
