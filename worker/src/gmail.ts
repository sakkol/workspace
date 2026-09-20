import type { RouteCtx } from "./ctx";
import { HttpErr, Bad } from "./errors";
import { buildRaw, parseOutgoing } from "./mime";

const ID = /^[\w-]{1,64}$/;
// Tabs: Inbox = Primary. Gmail combines several labelIds with AND.
const LABEL_IDS: Record<string, string[]> = {
  INBOX: ["INBOX", "CATEGORY_PERSONAL"],
  PROMOTIONS: ["INBOX", "CATEGORY_PROMOTIONS"],
  UPDATES: ["INBOX", "CATEGORY_UPDATES"],
  STARRED: ["STARRED"], SENT: ["SENT"], TRASH: ["TRASH"], ALL: [],
};
const MAX_THREAD_MSGS = 30;
const ACTIONS: Record<string, { addLabelIds?: string[]; removeLabelIds?: string[] }> = {
  read: { removeLabelIds: ["UNREAD"] },
  unread: { addLabelIds: ["UNREAD"] },
  star: { addLabelIds: ["STARRED"] },
  unstar: { removeLabelIds: ["STARRED"] },
  archive: { removeLabelIds: ["INBOX"] },
};

async function gmail(token: string, path: string, init?: { method?: string; body?: unknown }) {
  const r = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/" + path, {
    method: init?.method ?? "GET",
    headers: { Authorization: "Bearer " + token, ...(init?.body ? { "Content-Type": "application/json" } : {}) },
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
  if (r.status === 401) throw new HttpErr(401, "session_expired");
  if (r.status === 403) throw new HttpErr(403, "gmail_forbidden");
  if (r.status === 404) throw new HttpErr(404, "not_found");
  if (r.status === 429) throw new HttpErr(429, "gmail_rate_limited", r.headers.get("Retry-After"));
  if (!r.ok) throw new HttpErr(502, "gmail_unavailable");
  return r.status === 204 ? {} : ((await r.json()) as any);
}

const hdr = (m: any, n: string): string => m.payload?.headers?.find((h: any) => h.name.toLowerCase() === n)?.value ?? "";
const addrOf = (s: string) => (/<([^>]+)>/.exec(s)?.[1] ?? s).trim();
const dec = (d: string) => {
  const b = atob(d.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder().decode(Uint8Array.from(b, (c) => c.charCodeAt(0)));
};

/** Plain text only. HTML mail is reduced to text and is never returned as HTML. */
export function bodyText(payload: any, max = 200_000): string {
  const parts: any[] = [];
  const walk = (x: any) => { parts.push(x); (x.parts || []).forEach(walk); };
  walk(payload);
  const usable = (mt: string) => parts.find((x) => x.mimeType === mt && x.body?.data && !x.filename);
  const plain = usable("text/plain");
  if (plain) return dec(plain.body.data).slice(0, max);
  const html = usable("text/html");
  if (!html) return "(no readable text content)";
  return dec(html.body.data)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<(br|\/p|\/div|\/tr|\/li)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\n{3,}/g, "\n\n").trim().slice(0, max);
}

const summary = (g: any) => ({
  id: g.id as string,
  from: hdr(g, "from"), subject: hdr(g, "subject"), date: hdr(g, "date"), snippet: (g.snippet ?? "") as string,
  unread: (g.labelIds || []).includes("UNREAD"), starred: (g.labelIds || []).includes("STARRED"),
});

const nameOf = (s: string) => {
  const m = /^\s*"?([^"<]*?)"?\s*<[^>]+>\s*$/.exec(s);
  return (m?.[1] ?? "").trim() || addrOf(s);
};
const addrList = (s: string) => s.match(/[^\s<>,;"']+@[^\s<>,;"']+/g) ?? [];

/** One row of the conversation list. */
function threadSummary(t: any) {
  const ms: any[] = t.messages || [];
  const first = ms[0] ?? {}, last = ms[ms.length - 1] ?? {};
  const senders: string[] = [];
  for (const m of ms) {
    const n = (m.labelIds || []).includes("SENT") ? "me" : nameOf(hdr(m, "from"));
    if (n && !senders.includes(n)) senders.push(n);
  }
  return {
    id: t.id as string, subject: hdr(first, "subject"), senders: senders.slice(0, 4), count: ms.length,
    date: hdr(last, "date"), snippet: (t.snippet ?? last.snippet ?? "") as string,
    unread: ms.some((m) => (m.labelIds || []).includes("UNREAD")), starred: ms.some((m) => (m.labelIds || []).includes("STARRED")),
  };
}

export async function handleGmail(c: RouteCtx): Promise<Response> {
  const { p, req, u, J, store, bearer } = c;
  if (!(await c.lim("gmail", 120))) return J({ error: "rate_limited" }, 429);
  const s = bearer ? await store.auth(bearer, "gmail") : null;
  if (!s) return J({ error: "session_expired" }, 401);
  const token = s.token;
  const needWrite = () => { if (s.access !== "write") throw new HttpErr(403, "read_only"); };
  let m: RegExpMatchArray | null;

  if (p === "/gmail/profile" && req.method === "GET") {
    const l = await gmail(token, "labels/INBOX");
    return J({ unread: l.messagesUnread ?? 0, total: l.messagesTotal ?? 0, access: s.access, ttlMs: s.ttlMs });
  }

  // Conversation list (one row per thread). label = a tab or folder.
  if (p === "/gmail/threads" && req.method === "GET") {
    const label = u.searchParams.get("label") || "INBOX";
    if (!Object.hasOwn(LABEL_IDS, label)) throw new Bad("bad_label");
    const q = u.searchParams.get("q") || "";
    if (q.length > 200) throw new Bad("query_too_long");
    const pt = u.searchParams.get("pageToken") || "";
    if (pt && !/^[\w-]{1,300}$/.test(pt)) throw new Bad("bad_page");
    const qs = new URLSearchParams({ maxResults: "25" });
    for (const id of LABEL_IDS[label]) qs.append("labelIds", id);
    if (label === "TRASH") qs.set("includeSpamTrash", "true");
    if (q) qs.set("q", q);
    if (pt) qs.set("pageToken", pt);
    const l = await gmail(token, "threads?" + qs);
    const got = await Promise.allSettled((l.threads || []).map((x: any) =>
      gmail(token, `threads/${x.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`)));
    const threads = got.flatMap((r) => (r.status === "fulfilled" ? [threadSummary(r.value)] : []));
    // A dead token makes every sub-request fail with 401; surface that instead of an empty inbox.
    if (got.some((r) => r.status === "rejected" && (r as PromiseRejectedResult).reason instanceof HttpErr && (r as any).reason.status === 401)) throw new HttpErr(401, "session_expired");
    return J({ threads, nextPageToken: l.nextPageToken ?? null });
  }

  // One whole conversation, oldest first (the last MAX_THREAD_MSGS messages).
  if ((m = p.match(/^\/gmail\/threads\/([\w-]+)$/)) && req.method === "GET") {
    if (!ID.test(m[1])) throw new Bad("bad_id");
    const t = await gmail(token, `threads/${m[1]}?format=full`);
    const all: any[] = t.messages || [];
    const shown = all.slice(-MAX_THREAD_MSGS);
    return J({
      id: t.id, subject: hdr(all[0] ?? {}, "subject"), count: all.length, truncated: all.length > shown.length,
      messages: shown.map((g) => {
        const labels: string[] = g.labelIds || [], from = hdr(g, "from");
        return {
          id: g.id, from, fromAddr: addrOf(from), replyTo: addrOf(hdr(g, "reply-to") || from),
          to: hdr(g, "to"), toAddrs: addrList(hdr(g, "to")), cc: hdr(g, "cc"), date: hdr(g, "date"),
          unread: labels.includes("UNREAD"), starred: labels.includes("STARRED"), sent: labels.includes("SENT"),
          text: bodyText(g.payload, 60_000),
        };
      }),
    });
  }

  if ((m = p.match(/^\/gmail\/messages\/([\w-]+)$/)) && req.method === "GET") {
    if (!ID.test(m[1])) throw new Bad("bad_id");
    const g = await gmail(token, `messages/${m[1]}?format=full`);
    const from = hdr(g, "from");
    return J({
      ...summary(g), threadId: g.threadId, to: hdr(g, "to"), cc: hdr(g, "cc"),
      replyTo: addrOf(hdr(g, "reply-to") || from), fromAddr: addrOf(from), text: bodyText(g.payload),
    });
  }

  // Write actions work on a single message or a whole conversation (same whitelist, same limits).
  if ((m = p.match(/^\/gmail\/(messages|threads)\/([\w-]+)\/(action|trash|untrash)$/)) && req.method === "POST") {
    needWrite();
    if (!(await c.lim("gmail-write", 60))) return J({ error: "rate_limited" }, 429);
    const [, kind, id, op] = m;
    if (!ID.test(id)) throw new Bad("bad_id");
    if (op === "action") {
      const a = (await c.json()).action;
      if (typeof a !== "string" || !Object.hasOwn(ACTIONS, a)) throw new Bad("bad_action");
      await gmail(token, `${kind}/${id}/modify`, { method: "POST", body: ACTIONS[a] });
    } else {
      await gmail(token, `${kind}/${id}/${op}`, { method: "POST" }); // trash / untrash. There is NO permanent delete.
    }
    return J({ ok: true });
  }

  if (p === "/gmail/send" && req.method === "POST") {
    needWrite();
    if (!(await c.lim("gmail-send", 3))) return J({ error: "rate_limited" }, 429);
    const b = await c.json();
    const out = parseOutgoing(b); // validates everything before a send slot is spent
    let threadId: string | undefined;
    if (b.replyToId !== undefined && b.replyToId !== null && b.replyToId !== "") {
      if (typeof b.replyToId !== "string" || !ID.test(b.replyToId)) throw new Bad("bad_id");
      // Threading headers come from Gmail, never from the browser.
      const o = await gmail(token, `messages/${b.replyToId}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=References`);
      threadId = o.threadId;
      out.inReplyTo = hdr(o, "message-id") || undefined;
      out.references = [hdr(o, "references"), out.inReplyTo].filter(Boolean).join(" ") || undefined;
    }
    const slot = await store.sendSlot(bearer!);
    if (!slot.ok) return J({ error: slot.reason }, slot.reason === "send_limit" ? 429 : 401);
    await gmail(token, "messages/send", { method: "POST", body: { raw: buildRaw(out), ...(threadId ? { threadId } : {}) } });
    return J({ ok: true, sendsLeft: slot.left });
  }

  return J({ error: "not_found" }, 404);
}
