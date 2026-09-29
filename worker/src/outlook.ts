// Outlook mail through Microsoft Graph (v3). Same rules as gmail.ts: route allow-list, strict ID regexes, enum whitelists,
// the Relay builds every Graph request from structured fields, nothing the vendor returns is trusted (R12, R13).
//
// Never call Graph with DELETE (there is no permanent delete). Never call /me (R26: no account information).
import type { RouteCtx } from "./ctx";
import { HttpErr, Bad } from "./errors";
import { addrs, LIMITS, noCtl } from "./mime";
import { htmlToText } from "./text";

const GRAPH = "https://graph.microsoft.com/v1.0";
const ID = /^[A-Za-z0-9_=-]{1,300}$/; // Graph message / conversation ids are URL-safe base64
const PAGE = /^[ts]\.[A-Za-z0-9+/=_.~-]{1,2000}$/; // our own opaque page token: "t.<skiptoken>" or "s.<skip>"
const SKIP = /^\d{1,6}$/;
const MAX_CONV_MSGS = 30; // messages shown / touched per conversation
const LIST_TOP = 50;

// Folders the browser may name. Values are Graph well-known folder names.
const FOLDERS: Record<string, string> = { inbox: "inbox", sentitems: "sentitems", archive: "archive", deleteditems: "deleteditems", junkemail: "junkemail" };
const ACTIONS = ["read", "unread", "flag", "unflag", "archive"] as const;
type Action = (typeof ACTIONS)[number];

/** OData string literal: single quotes are doubled. Ids are ALSO regex-checked, so this is the second layer. */
export const odataStr = (s: string) => "'" + s.replace(/'/g, "''") + "'";

type Method = "GET" | "POST" | "PATCH"; // DELETE is deliberately not representable
async function graph(token: string, path: string, init?: { method?: Method; body?: unknown; text?: boolean }) {
  const method = init?.method ?? "GET";
  if ((method as string) === "DELETE") throw new Error("delete_not_allowed");
  // ImmutableId keeps a message's id stable when it is moved (archive / trash), so the browser's ids stay valid.
  const prefer = ['IdType="ImmutableId"', ...(init?.text ? ['outlook.body-content-type="text"'] : [])].join(", ");
  const r = await fetch(GRAPH + path, {
    method,
    headers: { Authorization: "Bearer " + token, Prefer: prefer, ...(init?.body ? { "Content-Type": "application/json" } : {}) },
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
  if (r.status === 401) throw new HttpErr(401, "session_expired");
  if (r.status === 403) throw new HttpErr(403, "outlook_forbidden");
  if (r.status === 404) throw new HttpErr(404, "not_found");
  if (r.status === 400) throw new HttpErr(400, "outlook_bad_request");
  if (r.status === 429) throw new HttpErr(429, "outlook_rate_limited", r.headers.get("Retry-After"));
  if (!r.ok) throw new HttpErr(502, "outlook_unavailable");
  if (r.status === 202 || r.status === 204) return {} as any; // sendMail / reply answer 202 with no body
  return (await r.json()) as any;
}

const enc = encodeURIComponent;
/** Query string with literal `$` in option names (`$filter`), values percent-encoded. */
const qs = (o: Record<string, string>) => Object.entries(o).map(([k, v]) => `${k}=${enc(v)}`).join("&");
const str = (x: unknown, max: number) => (typeof x === "string" ? x.slice(0, max) : "");
const addrOf = (e: any) => str(e?.emailAddress?.address, 254);
const nameOf = (e: any) => str(e?.emailAddress?.name, 200);
const label = (e: any) => { const a = addrOf(e), n = nameOf(e); return n && n !== a ? `${n} <${a}>` : a; };
const labels = (l: any) => (Array.isArray(l) ? l.slice(0, 50).map(label).filter(Boolean) : []);
const flagged = (m: any) => m?.flag?.flagStatus === "flagged";

/** Body as plain text. We ask Graph for text; if HTML arrives anyway it is reduced to text. Never returned as HTML. */
export function messageText(m: any, max = 60_000): string {
  const c = str(m?.body?.content, 400_000);
  if (!c) return str(m?.bodyPreview, max) || "(no readable text content)";
  const t = String(m?.body?.contentType ?? "").toLowerCase() === "html" || /^\s*<(!doctype|html|head|body|div|p|table)\b/i.test(c) ? htmlToText(c, max) : c.slice(0, max);
  return t.trim() || "(no readable text content)";
}

/**
 * Paging without following anything the vendor (or the browser) hands us. We read ONLY the skip value out of Graph's
 * @odata.nextLink, after checking it points at Graph, and hand the browser an opaque token. On the way back the token is
 * validated by regex and the request is rebuilt by us (SSRF guard).
 */
export function pageTokenFrom(nextLink: unknown): string | null {
  if (typeof nextLink !== "string") return null;
  let u: URL;
  try { u = new URL(nextLink); } catch { return null; }
  if (u.protocol !== "https:" || u.hostname !== "graph.microsoft.com") return null;
  const t = u.searchParams.get("$skiptoken"), s = u.searchParams.get("$skip");
  if (t && PAGE.test("t." + t)) return "t." + t;
  if (s && SKIP.test(s)) return "s." + s;
  return null;
}

const SUMMARY_SELECT = "id,conversationId,subject,from,receivedDateTime,isRead,bodyPreview,flag";
const FULL_SELECT = "id,subject,from,toRecipients,ccRecipients,replyTo,receivedDateTime,isRead,flag,body,bodyPreview,parentFolderId";

/** Group messages (newest first) into one row per conversation. */
export function groupConversations(msgs: any[]) {
  const map = new Map<string, any[]>();
  for (const m of msgs) {
    const id = typeof m?.conversationId === "string" ? m.conversationId : "";
    if (!ID.test(id)) continue; // never hand the browser an id we would refuse to accept back
    (map.get(id) ?? map.set(id, []).get(id)!).push(m);
  }
  return [...map].map(([id, ms]) => {
    const first = ms[0]; // newest
    const senders: string[] = [];
    for (const m of ms) { const n = nameOf(m.from) || addrOf(m.from); if (n && !senders.includes(n)) senders.push(n); }
    return {
      id, subject: str(first.subject, 300), senders: senders.slice(0, 4), count: ms.length,
      date: str(first.receivedDateTime, 40), snippet: str(first.bodyPreview, 300),
      unread: ms.some((m) => m.isRead === false), starred: ms.some(flagged),
    };
  });
}

const folderId = async (token: string, wk: string): Promise<string> => {
  const f = await graph(token, `/me/mailFolders/${wk}?$select=id`);
  return str(f.id, 400);
};

/** All messages of one conversation (ids + parent folder), bounded. The id is regex-checked by every caller. */
async function conversation(token: string, cid: string, select: string, text = false) {
  const r = await graph(token, "/me/messages?" + qs({ $filter: `conversationId eq ${odataStr(cid)}`, $select: select, $top: String(LIST_TOP) }), { text });
  const all: any[] = Array.isArray(r.value) ? r.value : [];
  // $orderby cannot be combined with this $filter on Graph, so sort here (oldest first).
  return all.sort((a, b) => String(a.receivedDateTime).localeCompare(String(b.receivedDateTime)));
}

async function applyOne(token: string, id: string, a: Action) {
  const mid = enc(id);
  if (a === "read") return graph(token, `/me/messages/${mid}`, { method: "PATCH", body: { isRead: true } });
  if (a === "unread") return graph(token, `/me/messages/${mid}`, { method: "PATCH", body: { isRead: false } });
  if (a === "flag") return graph(token, `/me/messages/${mid}`, { method: "PATCH", body: { flag: { flagStatus: "flagged" } } });
  if (a === "unflag") return graph(token, `/me/messages/${mid}`, { method: "PATCH", body: { flag: { flagStatus: "notFlagged" } } });
  return move(token, id, "archive");
}
const move = (token: string, id: string, dest: "archive" | "deleteditems" | "inbox") =>
  graph(token, `/me/messages/${enc(id)}/move`, { method: "POST", body: { destinationId: dest } }); // trash = move, never DELETE

export async function handleOutlook(c: RouteCtx): Promise<Response> {
  const { p, req, u, J, store, bearer } = c;
  if (!(await c.lim("outlook", 120))) return J({ error: "rate_limited" }, 429);
  const s = bearer ? await store.auth(bearer, "outlook") : null;
  if (!s) return J({ error: "session_expired" }, 401);
  const token = s.token;
  const needWrite = () => { if (s.access !== "write") throw new HttpErr(403, "read_only"); };
  let m: RegExpMatchArray | null;

  // Counts come from the inbox folder, NOT from /me (R26).
  if (p === "/outlook/profile" && req.method === "GET") {
    const f = await graph(token, "/me/mailFolders/inbox?$select=unreadItemCount,totalItemCount");
    return J({ unread: Number(f.unreadItemCount) || 0, total: Number(f.totalItemCount) || 0, access: s.access, ttlMs: s.ttlMs });
  }

  // Conversation list: Graph has no thread list, so fetch messages newest first and group them here.
  if (p === "/outlook/conversations" && req.method === "GET") {
    const folder = u.searchParams.get("folder") || "inbox";
    if (!Object.hasOwn(FOLDERS, folder)) throw new Bad("bad_folder");
    const pt = u.searchParams.get("pageToken") || "";
    if (pt && !PAGE.test(pt)) throw new Bad("bad_page");
    const q: Record<string, string> = { $top: String(LIST_TOP), $select: SUMMARY_SELECT, $orderby: "receivedDateTime desc" };
    if (pt) q[pt.startsWith("t.") ? "$skiptoken" : "$skip"] = pt.slice(2);
    const r = await graph(token, `/me/mailFolders/${FOLDERS[folder]}/messages?` + qs(q));
    return J({ threads: groupConversations(Array.isArray(r.value) ? r.value : []), nextPageToken: pageTokenFrom(r["@odata.nextLink"]) });
  }

  if ((m = p.match(/^\/outlook\/conversations\/([^/]+)$/)) && req.method === "GET") {
    if (!ID.test(m[1])) throw new Bad("bad_id");
    const all = await conversation(token, m[1], FULL_SELECT, true);
    const shown = all.slice(-MAX_CONV_MSGS);
    let sentId = "";
    try { sentId = await folderId(token, "sentitems"); } catch (e) { if (e instanceof HttpErr && e.status === 401) throw e; }
    return J({
      id: m[1], subject: str(all[0]?.subject, 300), count: all.length, truncated: all.length > shown.length,
      messages: shown.map((g) => {
        const reply = labels(g.replyTo);
        return {
          id: str(g.id, 300), from: label(g.from), fromAddr: addrOf(g.from), replyTo: addrOf(g.replyTo?.[0]) || addrOf(g.from),
          to: labels(g.toRecipients).join(", "), toAddrs: (g.toRecipients ?? []).slice(0, 50).map(addrOf).filter(Boolean),
          cc: labels(g.ccRecipients).join(", "), date: str(g.receivedDateTime, 40),
          unread: g.isRead === false, starred: flagged(g), sent: !!sentId && g.parentFolderId === sentId,
          text: messageText(g), replyHint: reply.length ? reply.join(", ") : label(g.from),
        };
      }),
    });
  }

  // ---- writes (write sessions only) ----
  // One message.
  if ((m = p.match(/^\/outlook\/messages\/([^/]+)\/(action|trash|untrash)$/)) && req.method === "POST") {
    needWrite();
    if (!(await c.lim("outlook-write", 60))) return J({ error: "rate_limited" }, 429);
    if (!ID.test(m[1])) throw new Bad("bad_id");
    if (m[2] === "action") {
      const a = (await c.json()).action;
      if (typeof a !== "string" || !(ACTIONS as readonly string[]).includes(a)) throw new Bad("bad_action");
      await applyOne(token, m[1], a as Action);
    } else await move(token, m[1], m[2] === "trash" ? "deleteditems" : "inbox");
    return J({ ok: true });
  }

  // A whole conversation (what the UI uses). Bounded to MAX_CONV_MSGS messages, applied one by one.
  if ((m = p.match(/^\/outlook\/conversations\/([^/]+)\/(action|trash|untrash)$/)) && req.method === "POST") {
    needWrite();
    if (!(await c.lim("outlook-write", 60))) return J({ error: "rate_limited" }, 429);
    if (!ID.test(m[1])) throw new Bad("bad_id");
    const b = await c.json();
    let a: Action | null = null;
    if (m[2] === "action") {
      if (typeof b.action !== "string" || !(ACTIONS as readonly string[]).includes(b.action)) throw new Bad("bad_action");
      a = b.action as Action;
    }
    const folder = b.folder === undefined ? "inbox" : b.folder;
    if (typeof folder !== "string" || !Object.hasOwn(FOLDERS, folder)) throw new Bad("bad_folder");
    const msgs = (await conversation(token, m[1], "id,isRead,flag,parentFolderId,receivedDateTime")).slice(-MAX_CONV_MSGS);
    const newest = msgs[msgs.length - 1];
    let todo: Array<{ id: string; run: () => Promise<unknown> }> = [];
    const id = (x: any) => str(x?.id, 300);
    const each = (list: any[], f: (i: string) => Promise<unknown>) => list.filter((x) => ID.test(id(x))).map((x) => ({ id: id(x), run: () => f(id(x)) }));
    if (a === "read") todo = each(msgs.filter((x) => x.isRead === false), (i) => applyOne(token, i, "read"));
    else if (a === "unread") todo = each(newest ? [newest] : [], (i) => applyOne(token, i, "unread"));
    else if (a === "flag") todo = each(newest ? [newest] : [], (i) => applyOne(token, i, "flag"));
    else if (a === "unflag") todo = each(msgs.filter(flagged), (i) => applyOne(token, i, "unflag"));
    else if (a === "archive") { const inbox = await folderId(token, "inbox"); todo = each(msgs.filter((x) => x.parentFolderId === inbox), (i) => move(token, i, "archive")); }
    else if (m[2] === "trash") { const from = await folderId(token, FOLDERS[folder]), bin = await folderId(token, "deleteditems"); todo = each(msgs.filter((x) => x.parentFolderId === from && from !== bin), (i) => move(token, i, "deleteditems")); }
    else { const bin = await folderId(token, "deleteditems"); todo = each(msgs.filter((x) => x.parentFolderId === bin), (i) => move(token, i, "inbox")); }
    for (const t of todo) await t.run(); // sequential: Graph limits concurrent requests per mailbox
    return J({ ok: true, changed: todo.length });
  }

  // New message. Structured fields only; the Relay builds the Graph JSON.
  if (p === "/outlook/send" && req.method === "POST") {
    needWrite();
    if (!(await c.lim("outlook-send", 3))) return J({ error: "rate_limited" }, 429);
    const b = await c.json();
    const to = addrs(b.to), cc = addrs(b.cc);
    if (to.length + cc.length < 1) throw new Bad("no_recipient");
    if (to.length + cc.length > LIMITS.rcpt) throw new Bad("too_many_recipients");
    const subject = typeof b.subject === "string" ? b.subject : "", body = typeof b.body === "string" ? b.body : "";
    if (subject.length > LIMITS.subject) throw new Bad("subject_too_long");
    if (body.length > LIMITS.body) throw new Bad("body_too_long");
    noCtl(subject);
    const slot = await store.sendSlot(bearer!, "outlook"); // counted before sending, like Gmail
    if (!slot.ok) return J({ error: slot.reason }, slot.reason === "send_limit" ? 429 : 401);
    const rc = (a: string[]) => a.map((address) => ({ emailAddress: { address } }));
    await graph(token, "/me/sendMail", { method: "POST", body: { message: { subject, body: { contentType: "Text", content: body }, toRecipients: rc(to), ccRecipients: rc(cc) }, saveToSentItems: true } });
    return J({ ok: true, sendsLeft: slot.left });
  }

  // Reply. Outlook chooses the recipients and quotes the original: the browser can only supply the comment text.
  if ((m = p.match(/^\/outlook\/messages\/([^/]+)\/reply$/)) && req.method === "POST") {
    needWrite();
    if (!(await c.lim("outlook-send", 3))) return J({ error: "rate_limited" }, 429);
    if (!ID.test(m[1])) throw new Bad("bad_id");
    const b = await c.json();
    const comment = typeof b.comment === "string" ? b.comment : "";
    if (comment.length > LIMITS.body) throw new Bad("body_too_long");
    const slot = await store.sendSlot(bearer!, "outlook");
    if (!slot.ok) return J({ error: slot.reason }, slot.reason === "send_limit" ? 429 : 401);
    await graph(token, `/me/messages/${enc(m[1])}/reply`, { method: "POST", body: { comment } });
    return J({ ok: true, sendsLeft: slot.left });
  }

  return J({ error: "not_found" }, 404);
}
