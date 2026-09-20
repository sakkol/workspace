import type { RouteCtx } from "./ctx";
import { HttpErr, Bad } from "./errors";
import { buildRaw, parseOutgoing } from "./mime";

const ID = /^[\w-]{1,64}$/;
const LABELS = new Set(["INBOX", "STARRED", "SENT", "TRASH", "ALL"]);
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
export function bodyText(payload: any): string {
  const parts: any[] = [];
  const walk = (x: any) => { parts.push(x); (x.parts || []).forEach(walk); };
  walk(payload);
  const usable = (mt: string) => parts.find((x) => x.mimeType === mt && x.body?.data && !x.filename);
  const plain = usable("text/plain");
  if (plain) return dec(plain.body.data).slice(0, 200_000);
  const html = usable("text/html");
  if (!html) return "(no readable text content)";
  return dec(html.body.data)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<(br|\/p|\/div|\/tr|\/li)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\n{3,}/g, "\n\n").trim().slice(0, 200_000);
}

const summary = (g: any) => ({
  id: g.id as string,
  from: hdr(g, "from"), subject: hdr(g, "subject"), date: hdr(g, "date"), snippet: (g.snippet ?? "") as string,
  unread: (g.labelIds || []).includes("UNREAD"), starred: (g.labelIds || []).includes("STARRED"),
});

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

  if (p === "/gmail/messages" && req.method === "GET") {
    const label = u.searchParams.get("label") || "INBOX";
    if (!LABELS.has(label)) throw new Bad("bad_label");
    const q = u.searchParams.get("q") || "";
    if (q.length > 200) throw new Bad("query_too_long");
    const pt = u.searchParams.get("pageToken") || "";
    if (pt && !/^[\w-]{1,300}$/.test(pt)) throw new Bad("bad_page");
    const qs = new URLSearchParams({ maxResults: "25" });
    if (label !== "ALL") qs.set("labelIds", label);
    if (label === "TRASH") qs.set("includeSpamTrash", "true");
    if (q) qs.set("q", q);
    if (pt) qs.set("pageToken", pt);
    const l = await gmail(token, "messages?" + qs);
    const got = await Promise.allSettled((l.messages || []).map((x: any) =>
      gmail(token, `messages/${x.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`)));
    const messages = got.flatMap((r) => (r.status === "fulfilled" ? [summary(r.value)] : []));
    // A dead token makes every sub-request fail with 401; surface that instead of an empty inbox.
    const dead = got.find((r) => r.status === "rejected" && (r as PromiseRejectedResult).reason instanceof HttpErr && (r as any).reason.status === 401);
    if (dead) throw new HttpErr(401, "session_expired");
    return J({ messages, nextPageToken: l.nextPageToken ?? null });
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

  if ((m = p.match(/^\/gmail\/messages\/([\w-]+)\/(action|trash|untrash)$/)) && req.method === "POST") {
    needWrite();
    if (!(await c.lim("gmail-write", 60))) return J({ error: "rate_limited" }, 429);
    if (!ID.test(m[1])) throw new Bad("bad_id");
    if (m[2] === "action") {
      const a = (await c.json()).action;
      if (typeof a !== "string" || !Object.hasOwn(ACTIONS, a)) throw new Bad("bad_action");
      await gmail(token, `messages/${m[1]}/modify`, { method: "POST", body: ACTIONS[a] });
    } else {
      await gmail(token, `messages/${m[1]}/${m[2]}`, { method: "POST" }); // trash / untrash. There is NO permanent delete.
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
