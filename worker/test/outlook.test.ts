// v3: Outlook (Microsoft Graph). Router-level tests with a fake Durable Object and a fake Microsoft.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

import worker from "../src/index";
import { StoreCore } from "../src/core";
import { FakeKV, setup, approvedTx } from "./helpers";
import { b64u, sha } from "../src/security";
import { normalizeScope, scopesGranted, APPS } from "../src/apps";
import { VENDORS, tenantOf } from "../src/vendors";
import { groupConversations, messageText, odataStr, pageTokenFrom } from "../src/outlook";

const ORIGIN = "https://front.example";
const RELAY = "https://relay.example";
const TOKEN = "EwB4A8l6BAAU-SUPER-SECRET-MS-ACCESS-TOKEN";
const REFRESH = "M.C507_REFRESH-MUST-NOT-BE-KEPT";
const READ = "https://graph.microsoft.com/Mail.Read";
const WRITE = "https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Send";

let core: StoreCore;
let env: any;
let calls: Array<{ url: string; method: string; body?: string; headers: Record<string, string> }>;
let grantedScope: string;
let graphStatus: number; // when not 200, every Graph call answers with it
let nextLink: string | null;
let errSpy: any;

const dec = (u: string) => decodeURIComponent(u);
const MSGS = [
  { id: "m2", conversationId: "cA", subject: "Plans", from: { emailAddress: { name: "Ada L", address: "ada@x.com" } }, receivedDateTime: "2026-01-02T10:00:00Z", isRead: false, bodyPreview: "thanks!", flag: { flagStatus: "notFlagged" } },
  { id: "m1", conversationId: "cA", subject: "Plans", from: { emailAddress: { name: "Me", address: "me@hotmail.com" } }, receivedDateTime: "2026-01-01T10:00:00Z", isRead: true, bodyPreview: "hi", flag: { flagStatus: "flagged" } },
  { id: "m3", conversationId: "cB", subject: "Invoice", from: { emailAddress: { name: "", address: "billing@y.com" } }, receivedDateTime: "2026-01-01T09:00:00Z", isRead: true, bodyPreview: "due", flag: { flagStatus: "notFlagged" } },
];
const FULL = [
  { id: "m1", subject: "Plans", from: { emailAddress: { name: "Me", address: "me@hotmail.com" } }, toRecipients: [{ emailAddress: { name: "Ada L", address: "ada@x.com" } }], ccRecipients: [], replyTo: [], receivedDateTime: "2026-01-01T10:00:00Z", isRead: true, flag: { flagStatus: "notFlagged" }, parentFolderId: "F-SENT", body: { contentType: "text", content: "hello" } },
  { id: "m2", subject: "Plans", from: { emailAddress: { name: "Ada L", address: "ada@x.com" } }, toRecipients: [{ emailAddress: { name: "", address: "me@hotmail.com" } }], ccRecipients: [], replyTo: [{ emailAddress: { name: "Ada Work", address: "ada@work.com" } }], receivedDateTime: "2026-01-02T10:00:00Z", isRead: false, flag: { flagStatus: "notFlagged" }, parentFolderId: "F-INBOX",
    body: { contentType: "html", content: "<p>Hi <b>there</b></p><script>alert(1)</script><a href='http://evil'>click</a>" } },
];
const FOLDER_IDS: Record<string, string> = { inbox: "F-INBOX", sentitems: "F-SENT", deleteditems: "F-BIN", archive: "F-ARCH" };

beforeEach(() => {
  core = new StoreCore(new FakeKV(), {
    seal: async (p, aad) => `sealed:${aad}:${p}`, open: async (s, aad) => s.slice(`sealed:${aad}:`.length), revoke: () => {},
  });
  env = {
    STORE: { getByName: () => core },
    FRONTEND_ORIGIN: ORIGIN, FRONTEND_URL: ORIGIN + "/workspace/", TOKEN_KEY: "x",
    GOOGLE_CLIENT_ID: "gid", GOOGLE_CLIENT_SECRET: "gsecret", GOOGLE_REDIRECT_URI: RELAY + "/oauth/google/callback",
    MICROSOFT_CLIENT_ID: "mid", MICROSOFT_CLIENT_SECRET: "msecret", MICROSOFT_REDIRECT_URI: RELAY + "/oauth/microsoft/callback",
  };
  calls = []; graphStatus = 200; nextLink = null;
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal("fetch", async (url: any, init?: RequestInit) => {
    const u = String(url), method = init?.method ?? "GET";
    calls.push({ url: u, method, body: init?.body === undefined ? undefined : String(init.body), headers: (init?.headers ?? {}) as Record<string, string> });
    if (u === "https://login.microsoftonline.com/consumers/oauth2/v2.0/token")
      return Response.json({ access_token: TOKEN, refresh_token: REFRESH, expires_in: 4500, scope: grantedScope, token_type: "Bearer" });
    if (u === "https://oauth2.googleapis.com/token") return Response.json({ access_token: "ya29.G", expires_in: 3600, scope: grantedScope });
    if (!u.startsWith("https://graph.microsoft.com/v1.0")) return new Response("{}", { status: 404 });
    if (graphStatus !== 200) return new Response("{}", { status: graphStatus, headers: graphStatus === 429 ? { "Retry-After": "7" } : {} });
    const d = dec(u);
    if (u.includes("/me/mailFolders/inbox?$select=unreadItemCount")) return Response.json({ unreadItemCount: 4, totalItemCount: 99 });
    let fm = /\/me\/mailFolders\/(\w+)\?\$select=id$/.exec(u);
    if (fm) return Response.json({ id: FOLDER_IDS[fm[1]] });
    if (u.includes("/messages?") && u.includes("/mailFolders/")) {
      if (nextLink === "SKIP") return Response.json({ value: MSGS.slice(0, 1), "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?%24top=50&%24skip=50" });
      if (u.includes("$skiptoken=")) return Response.json({ value: [] });
      return Response.json({ value: MSGS, "@odata.nextLink": nextLink ?? "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?%24top=50&%24skiptoken=ABC%2B123%3D" });
    }
    if (u.includes("/me/messages?") && d.includes("conversationId eq")) return Response.json({ value: d.includes("body") ? FULL : FULL.map(({ id, parentFolderId, isRead, flag, receivedDateTime }) => ({ id, parentFolderId, isRead, flag, receivedDateTime })) });
    if (method === "POST" && u.endsWith("/me/sendMail")) return new Response(null, { status: 202 });
    if (method === "POST" && u.endsWith("/reply")) return new Response(null, { status: 202 });
    if (method === "POST" && u.endsWith("/move")) return Response.json({ id: "moved" });
    if (method === "PATCH") return Response.json({});
    return new Response("{}", { status: 404 });
  });
});
afterEach(() => {
  // R14: permanent deletion never happens, in any test, and no account information is ever requested (R26)
  expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  expect(calls.some((c) => /\/v1\.0\/me(\?|$)/.test(c.url))).toBe(false);
  errSpy.mockRestore();
});

const call = (path: string, init: RequestInit & { origin?: string | null } = {}) => {
  const headers = new Headers(init.headers);
  if (init.origin !== null) headers.set("Origin", init.origin ?? ORIGIN);
  return worker.fetch(new Request(RELAY + path, { ...init, headers }), env);
};
const post = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
  call(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body), headers });
const bearer = (cap: string) => ({ Authorization: "Bearer " + cap });

async function unlock(app: "outlook" | "gmail" = "outlook", access: "read" | "write" = "read", grant?: string) {
  const secret = b64u(crypto.getRandomValues(new Uint8Array(32)));
  const start = await (await post("/link/start", { app, access, claimHash: await sha(secret) })).json() as any;
  const info = await (await call("/link/info/" + start.id)).json() as any;
  const conf = await (await post("/link/confirm/" + start.id, { code: start.code })).json() as any;
  const vendor = app === "outlook" ? "microsoft" : "google";
  const auth = await call(`/oauth/${vendor}?tx=${start.id}&n=${conf.nonce}`, { origin: null });
  const authUrl = new URL(auth.headers.get("Location")!);
  grantedScope = grant ?? authUrl.searchParams.get("scope")!;
  const cb = await call(`/oauth/${vendor}/callback?code=abc&state=${encodeURIComponent(authUrl.searchParams.get("state")!)}`, { origin: null });
  const claim = () => post("/link/claim/" + start.id, undefined, { "X-Claim-Secret": secret });
  return { start, info, secret, authUrl, cb, claim, cap: async () => ((await (await claim()).json()) as any).cap as string };
}
const rw = async () => bearer(await (await unlock("outlook", "write")).cap());
const ro = async () => bearer(await (await unlock("outlook", "read")).cap());

describe("scope normalizer", () => {
  it("tolerates casing, the graph prefix and extra default scopes; a missing scope fails", () => {
    expect(normalizeScope("microsoft", "https://graph.microsoft.com/Mail.Read")).toBe("mail.read");
    expect(normalizeScope("microsoft", "MAIL.READ")).toBe("mail.read");
    expect(scopesGranted("microsoft", READ, "mail.read")).toBe(true);
    expect(scopesGranted("microsoft", READ, "User.Read profile openid email Mail.Read")).toBe(true);
    expect(scopesGranted("microsoft", WRITE, "https://graph.microsoft.com/mail.readwrite https://graph.microsoft.com/MAIL.SEND")).toBe(true);
    expect(scopesGranted("microsoft", WRITE, "Mail.ReadWrite User.Read")).toBe(false); // Mail.Send unticked
    expect(scopesGranted("microsoft", READ, "Mail.ReadBasic")).toBe(false);
    expect(scopesGranted("microsoft", READ, "")).toBe(false);
    expect(scopesGranted("google", "A", "a")).toBe(false); // other vendors keep exact matching
  });
  it("the Outlook app never asks for forbidden scopes", () => {
    for (const s of Object.values(APPS.outlook.scopes)) expect(s).not.toMatch(/offline_access|MailboxSettings|Shared|Contacts|Calendars|User\.|Directory|openid|profile/i);
    expect(VENDORS.microsoft.revoke).toBeNull();
    expect(VENDORS.microsoft.expectsRefreshToken).toBe(false);
  });
});

describe("configuration (fail closed)", () => {
  it("/health reports booleans", async () => {
    const j = await (await call("/health", { origin: null })).json() as any;
    expect(j.configured.microsoft).toBe(true);
    delete env.MICROSOFT_CLIENT_SECRET;
    expect((await (await call("/health", { origin: null })).json() as any).configured.microsoft).toBe(false);
  });
  it("not configured -> app_not_configured; invalid tenant -> not configured", async () => {
    env.MICROSOFT_CLIENT_ID = "";
    let r = await post("/link/start", { app: "outlook", access: "read", claimHash: await sha("x") });
    expect([r.status, await r.json()]).toEqual([503, { error: "app_not_configured" }]);
    env.MICROSOFT_CLIENT_ID = "mid"; env.MICROSOFT_TENANT = "evil.com/../x";
    r = await post("/link/start", { app: "outlook", access: "read", claimHash: await sha("x") });
    expect(r.status).toBe(503);
    expect(tenantOf({ ...env, MICROSOFT_TENANT: "" })).toBe("consumers");
    expect(tenantOf({ ...env, MICROSOFT_TENANT: "common" })).toBe("common");
    expect(tenantOf({ ...env, MICROSOFT_TENANT: "8f1c2b4e-1111-2222-3333-444455556666" })).toBe("8f1c2b4e-1111-2222-3333-444455556666");
  });
});

describe("unlock", () => {
  it("authorize URL: PKCE S256, state, exact redirect, exact scopes, no offline_access / include_granted_scopes / secret", async () => {
    const u = await unlock("outlook", "read");
    expect(u.info.describe).toMatch(/Outlook/);
    expect(u.authUrl.origin + u.authUrl.pathname).toBe("https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize");
    const q = u.authUrl.searchParams;
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("code_challenge")).toMatch(/^[\w-]{43}$/);
    expect(q.get("state")).toMatch(/\./);
    expect(q.get("redirect_uri")).toBe(RELAY + "/oauth/microsoft/callback");
    expect(q.get("client_id")).toBe("mid");
    expect(q.get("response_type")).toBe("code");
    expect(q.get("scope")).toBe(READ);
    expect(q.get("prompt")).toBe("select_account");
    for (const bad of ["offline_access", "include_granted_scopes", "client_secret", "access_type"]) expect(q.has(bad)).toBe(false);
    expect(u.authUrl.toString()).not.toMatch(/offline_access|msecret/);
    expect(u.cb.headers.get("Location")).toBe(`${ORIGIN}/workspace/#/p/${u.start.id}/done`);
  });
  it("write level asks for exactly Mail.ReadWrite + Mail.Send", async () => {
    const u = await unlock("outlook", "write");
    expect(u.authUrl.searchParams.get("scope")).toBe(WRITE);
  });
  it("token exchange: secret stays on the Relay; a refresh token is discarded and logged only as an event", async () => {
    const u = await unlock("outlook", "read");
    const ex = calls.find((c) => c.url.includes("login.microsoftonline.com") && c.url.endsWith("/token"))!;
    expect(ex.body).toContain("client_secret=msecret");
    expect(ex.body).toContain("code_verifier=");
    expect(ex.body).toContain("grant_type=authorization_code");
    expect(ex.body).not.toContain("offline_access");
    const claimed = await (await u.claim()).json() as any;
    const cap = claimed.cap;
    const prof = await call("/outlook/profile", { headers: bearer(cap) });
    const everything = JSON.stringify(claimed) + (await prof.text()) + u.cb.headers.get("Location");
    expect(everything).not.toContain(REFRESH);
    expect(everything).not.toContain(TOKEN);
    expect(errSpy).toHaveBeenCalledWith("security_event: unexpected_refresh_token (discarded)");
    expect(JSON.stringify(errSpy.mock.calls)).not.toContain(REFRESH);
    expect(JSON.stringify(errSpy.mock.calls)).not.toContain(TOKEN);
    // session lifetime follows expires_in (4500 s) but is capped at 30 min
    expect(claimed.ttlMs).toBe(30 * 60_000);
  });
  it("a missing granted scope (Mail.Send unticked) is rejected; extra default scopes are tolerated", async () => {
    const bad = await unlock("outlook", "write", "Mail.ReadWrite User.Read");
    expect(bad.cb.headers.get("Location")).toContain("error?r=scope");
    expect((await bad.claim()).status).toBe(409);
    const ok = await unlock("outlook", "write", "Mail.ReadWrite Mail.Send User.Read profile openid email");
    expect(ok.cb.headers.get("Location")).toContain("/done");
    expect((await ok.claim()).status).toBe(200);
  });
});

describe("capability binding (R4)", () => {
  it("Outlook capability is 401 on Gmail and Spotify routes, and the reverse", async () => {
    const o = await unlock("outlook", "write"), g = await unlock("gmail", "write");
    const oc = await o.cap(), gc = await g.cap();
    for (const path of ["/gmail/profile", "/spotify/player"]) expect((await call(path, { headers: bearer(oc) })).status).toBe(401);
    expect((await post("/gmail/send", { to: ["a@b.com"], subject: "s", body: "b" }, bearer(oc))).status).toBe(401);
    expect((await call("/outlook/profile", { headers: bearer(gc) })).status).toBe(401);
    expect((await post("/outlook/send", { to: ["a@b.com"], subject: "s", body: "b" }, bearer(gc))).status).toBe(401);
    expect((await call("/outlook/profile", { headers: bearer(oc) })).status).toBe(200);
  });
  it("401 without or with a garbage capability; workspace origin only", async () => {
    expect((await call("/outlook/profile")).status).toBe(401);
    expect((await call("/outlook/profile", { headers: bearer("short") })).status).toBe(401);
    expect((await call("/outlook/profile", { origin: "https://evil.example" })).status).toBe(403);
  });
});

describe("reading", () => {
  it("profile: counts come from the inbox folder, no identity", async () => {
    const h = await ro();
    const j = await (await call("/outlook/profile", { headers: h })).json() as any;
    expect(j).toMatchObject({ unread: 4, total: 99, access: "read" });
    expect(JSON.stringify(j)).not.toMatch(/@|hotmail/);
  });
  it("groups messages into conversations, newest first, with flags", async () => {
    const h = await ro();
    const j = await (await call("/outlook/conversations", { headers: h })).json() as any;
    expect(j.threads).toHaveLength(2);
    expect(j.threads[0]).toMatchObject({ id: "cA", subject: "Plans", count: 2, unread: true, starred: true, senders: ["Ada L", "Me"], snippet: "thanks!" });
    expect(j.threads[1]).toMatchObject({ id: "cB", senders: ["billing@y.com"] });
    const list = calls.find((c) => c.url.includes("/mailFolders/inbox/messages?"))!;
    expect(dec(list.url)).toContain("$orderby=receivedDateTime desc");
    expect(dec(list.url)).toContain("$select=id,conversationId,subject,from,receivedDateTime,isRead,bodyPreview,flag");
    expect(list.headers.Prefer).toContain('IdType="ImmutableId"');
  });
  it("folder whitelist", async () => {
    const h = await ro();
    for (const f of ["sentitems", "archive", "deleteditems", "junkemail"]) expect((await call("/outlook/conversations?folder=" + f, { headers: h })).status).toBe(200);
    for (const f of ["bogus", "constructor", "__proto__", "inbox/../me", "inbox%2F..", "me"]) expect((await call("/outlook/conversations?folder=" + encodeURIComponent(f), { headers: h })).status).toBe(400);
  });
  it("paging: only the skip token is extracted; the request is rebuilt by the Relay", async () => {
    const h = await ro();
    const j1 = await (await call("/outlook/conversations", { headers: h })).json() as any;
    expect(j1.nextPageToken).toBe("t.ABC+123=");
    expect(JSON.stringify(j1)).not.toContain("graph.microsoft.com");
    calls.length = 0;
    await call("/outlook/conversations?pageToken=" + encodeURIComponent(j1.nextPageToken), { headers: h });
    const next = calls.find((c) => c.url.includes("/mailFolders/inbox/messages?"))!;
    expect(next.url.startsWith("https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?")).toBe(true);
    expect(dec(next.url)).toContain("$skiptoken=ABC+123=");
    // $skip style
    nextLink = "SKIP";
    expect((await (await call("/outlook/conversations", { headers: h })).json() as any).nextPageToken).toBe("s.50");
  });
  it("SSRF: client-supplied or foreign next links are never followed", async () => {
    const h = await ro();
    for (const pt of ["https://evil.example/x", "http://graph.microsoft.com/v1.0/me/messages", "//evil", "t.", "x.abc", "t.a b", "t.a&$top=1", "t.a'b", "../../me", "t." + "a".repeat(2001)])
      expect([pt, (await call("/outlook/conversations?pageToken=" + encodeURIComponent(pt), { headers: h })).status]).toEqual([pt, 400]);
    nextLink = "https://evil.example/steal?%24skiptoken=abc";
    const j = await (await call("/outlook/conversations", { headers: h })).json() as any;
    expect(j.nextPageToken).toBeNull();
    expect(calls.some((c) => c.url.startsWith("https://evil.example"))).toBe(false);
    expect(pageTokenFrom("https://graph.microsoft.com.evil.example/x?$skiptoken=a")).toBeNull();
    expect(pageTokenFrom("https://graph.microsoft.com/v1.0/x?$skiptoken=a%27b")).toBeNull();
    expect(pageTokenFrom("nonsense")).toBeNull();
    expect(pageTokenFrom(undefined)).toBeNull();
  });
  it("conversation view: sorted oldest first, real addresses, sent flag, HTML reduced to text, no links", async () => {
    const h = await ro();
    const j = await (await call("/outlook/conversations/cA", { headers: h })).json() as any;
    expect(j.count).toBe(2);
    expect(j.messages.map((m: any) => m.id)).toEqual(["m1", "m2"]);
    expect(j.messages[0]).toMatchObject({ sent: true, text: "hello", fromAddr: "me@hotmail.com", toAddrs: ["ada@x.com"] });
    expect(j.messages[1]).toMatchObject({ sent: false, fromAddr: "ada@x.com", replyTo: "ada@work.com", unread: true });
    expect(j.messages[1].from).toBe("Ada L <ada@x.com>");
    expect(j.messages[1].text).toContain("Hi there");
    expect(j.messages[1].text).not.toMatch(/[<>]|alert|script/);
    const q = calls.find((c) => c.url.includes("/me/messages?"))!;
    expect(dec(q.url)).toContain("$filter=conversationId eq 'cA'");
    expect(q.headers.Prefer).toContain('outlook.body-content-type="text"');
  });
  it("OData injection: conversation ids are regex-checked", async () => {
    const h = await ro();
    for (const id of ["x' or 1 eq 1 or '", "a'b", "a b", "a%27b", "a;b", "a\"b", "a$b", "a,b", "x".repeat(301)])
      expect([id, (await call("/outlook/conversations/" + encodeURIComponent(id), { headers: h })).status]).toEqual([id, 400]);
    expect(calls.some((c) => c.url.includes("conversationId"))).toBe(false);
    expect(odataStr("a'b")).toBe("'a''b'");
    expect(odataStr("'; drop")).toBe("'''; drop'");
    expect((await call("/outlook/conversations/AAQkAGI2-_=", { headers: h })).status).toBe(200);
  });
  it("hostile content stays inert text", () => {
    const t = messageText({ body: { contentType: "html", content: "<svg onload=alert(1)><style>x{}</style>a&lt;b<iframe src=x></iframe><br>next" } });
    expect(t).not.toMatch(/<svg|<iframe|onload|<style/);
    expect(messageText({ body: { contentType: "text", content: "x".repeat(200_000) } }).length).toBe(60_000);
    expect(messageText({ body: { contentType: "text", content: "<b>literal</b>" } })).toBe("<b>literal</b>"); // plain text stays plain text; the UI shows it in a <pre>
    expect(messageText({})).toBe("(no readable text content)");
    expect(groupConversations([{ conversationId: "bad id'", subject: "x" }, { conversationId: "ok_1=", subject: "y", from: {}, receivedDateTime: "d" }]).map((x) => x.id)).toEqual(["ok_1="]);
  });
});

describe("read-only sessions cannot write", () => {
  it("send, reply, action, trash, untrash (message and conversation) are all 403 and nothing reaches Graph", async () => {
    const h = await ro();
    calls.length = 0;
    const r = await Promise.all([
      post("/outlook/send", { to: ["a@b.com"], subject: "s", body: "b" }, h),
      post("/outlook/messages/m1/reply", { comment: "hi" }, h),
      post("/outlook/messages/m1/action", { action: "flag" }, h),
      post("/outlook/messages/m1/trash", undefined, h),
      post("/outlook/messages/m1/untrash", undefined, h),
      post("/outlook/conversations/cA/action", { action: "archive" }, h),
      post("/outlook/conversations/cA/trash", undefined, h),
      post("/outlook/conversations/cA/untrash", undefined, h),
    ]);
    expect(r.map((x) => x.status)).toEqual(Array(8).fill(403));
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
    expect(calls.some((c) => c.url.includes("graph.microsoft.com"))).toBe(false);
  });
});

describe("write sessions", () => {
  it("message actions use PATCH / move; unknown actions and ids are rejected", async () => {
    const h = await rw();
    calls.length = 0;
    expect((await post("/outlook/messages/m1/action", { action: "read" }, h)).status).toBe(200);
    expect((await post("/outlook/messages/m1/action", { action: "unread" }, h)).status).toBe(200);
    expect((await post("/outlook/messages/m1/action", { action: "flag" }, h)).status).toBe(200);
    expect((await post("/outlook/messages/m1/action", { action: "unflag" }, h)).status).toBe(200);
    expect((await post("/outlook/messages/m1/action", { action: "archive" }, h)).status).toBe(200);
    const w = calls.filter((c) => c.method !== "GET");
    expect(w.map((c) => [c.method, JSON.parse(c.body!)])).toEqual([
      ["PATCH", { isRead: true }], ["PATCH", { isRead: false }], ["PATCH", { flag: { flagStatus: "flagged" } }],
      ["PATCH", { flag: { flagStatus: "notFlagged" } }], ["POST", { destinationId: "archive" }],
    ]);
    for (const a of ["delete", "constructor", "", 5, null]) expect((await post("/outlook/messages/m1/action", { action: a }, h)).status).toBe(400);
    for (const id of ["a'b", "a b", "a%2Fb", "x".repeat(301)]) expect((await post("/outlook/messages/" + encodeURIComponent(id) + "/trash", undefined, h)).status).toBe(400);
  });
  it("trash = move to deleteditems, untrash = move to inbox, never DELETE", async () => {
    const h = await rw();
    calls.length = 0;
    await post("/outlook/messages/m1/trash", undefined, h);
    await post("/outlook/messages/m1/untrash", undefined, h);
    const w = calls.filter((c) => c.method !== "GET");
    expect(w.map((c) => [c.method, c.url.endsWith("/move"), JSON.parse(c.body!).destinationId])).toEqual([["POST", true, "deleteditems"], ["POST", true, "inbox"]]);
  });
  it("conversation actions only touch the right messages and are bounded", async () => {
    const h = await rw();
    calls.length = 0;
    const r = await (await post("/outlook/conversations/cA/trash", { folder: "inbox" }, h)).json() as any;
    expect(r).toEqual({ ok: true, changed: 1 }); // only m2 lives in the inbox; m1 is in Sent Items
    expect(calls.filter((c) => c.method === "POST").map((c) => JSON.parse(c.body!).destinationId)).toEqual(["deleteditems"]);
    expect((await post("/outlook/conversations/cA/trash", { folder: "nope" }, h)).status).toBe(400);
    expect((await post("/outlook/conversations/cA/action", { action: "delete" }, h)).status).toBe(400);
    calls.length = 0;
    expect(await (await post("/outlook/conversations/cA/action", { action: "read" }, h)).json()).toEqual({ ok: true, changed: 1 }); // only the unread one
    expect(await (await post("/outlook/conversations/cA/action", { action: "archive" }, h)).json()).toEqual({ ok: true, changed: 1 });
  });
  it("send: Graph JSON is built by the Relay (Text, saveToSentItems); injection, recipient and size limits", async () => {
    const h = await rw();
    calls.length = 0;
    const ok = await post("/outlook/send", { to: ["a@b.com"], cc: ["c@d.com"], subject: "Hi", body: "Hello", from: "x@y.com", bcc: ["z@z.com"], saveToSentItems: false }, h);
    expect(ok.status).toBe(200);
    const sent = calls.find((c) => c.url.endsWith("/me/sendMail"))!;
    expect(JSON.parse(sent.body!)).toEqual({ message: { subject: "Hi", body: { contentType: "Text", content: "Hello" }, toRecipients: [{ emailAddress: { address: "a@b.com" } }], ccRecipients: [{ emailAddress: { address: "c@d.com" } }] }, saveToSentItems: true });
    (core as any).rl.clear();
    const bad = async (b: any) => { (core as any).rl.clear(); return (await post("/outlook/send", b, h)).status; };
    expect(await bad({ to: ["a@b.com\r\nBcc: x@y.com"], subject: "s", body: "b" })).toBe(400);
    expect(await bad({ to: ["a@b.com"], subject: "s\nBcc: x@y.com", body: "b" })).toBe(400);
    expect(await bad({ to: [], subject: "s", body: "b" })).toBe(400);
    expect(await bad({ to: Array(11).fill("a@b.com"), subject: "s", body: "b" })).toBe(400);
    expect(await bad({ to: ["a@b.com"], subject: "s".repeat(151), body: "b" })).toBe(400);
    expect(await bad({ to: ["a@b.com"], subject: "s", body: "b".repeat(50_001) })).toBe(400);
    expect(await bad({ to: "a@b.com", subject: "s", body: "b" })).toBe(400);
    expect(calls.filter((c) => c.url.endsWith("/me/sendMail"))).toHaveLength(1);
  });
  it("reply: recipients come from Outlook; the browser can only send the comment", async () => {
    const h = await rw();
    calls.length = 0;
    const r = await post("/outlook/messages/m2/reply", { comment: "Sure", to: ["evil@x.com"], cc: ["evil@x.com"], toRecipients: [{}] }, h);
    expect(r.status).toBe(200);
    const c = calls.find((x) => x.url.endsWith("/messages/m2/reply"))!;
    expect(JSON.parse(c.body!)).toEqual({ comment: "Sure" });
    (core as any).rl.clear();
    expect((await post("/outlook/messages/a'b/reply", { comment: "x" }, h)).status).toBe(400);
    expect((await post("/outlook/messages/m2/reply", { comment: "x".repeat(50_001) }, h)).status).toBe(400);
  });
  it("10 sends per session (send + reply share the counter)", async () => {
    const h = await rw();
    for (let i = 0; i < 10; i++) { (core as any).rl.clear(); expect((await (i % 2 ? post("/outlook/messages/m2/reply", { comment: "x" }, h) : post("/outlook/send", { to: ["a@b.com"], subject: "s", body: "b" }, h))).status).toBe(200); }
    (core as any).rl.clear();
    const over = await post("/outlook/send", { to: ["a@b.com"], subject: "s", body: "b" }, h);
    expect([over.status, await over.json()]).toEqual([429, { error: "send_limit" }]);
    expect(calls.filter((c) => c.url.endsWith("/me/sendMail") || c.url.endsWith("/reply"))).toHaveLength(10);
  });
  it("per-minute send limit", async () => {
    const h = await rw();
    const s = [];
    for (let i = 0; i < 4; i++) s.push((await post("/outlook/send", { to: ["a@b.com"], subject: "s", body: "b" }, h)).status);
    expect(s).toEqual([200, 200, 200, 429]);
  });
});

describe("Microsoft errors", () => {
  it("401 ends the session; 403, 404, 429 (Retry-After), 5xx are mapped", async () => {
    const o = await unlock("outlook", "read"); const cap = await o.cap(); const h = bearer(cap);
    for (const [st, code] of [[403, "outlook_forbidden"], [404, "not_found"], [429, "outlook_rate_limited"], [500, "outlook_unavailable"], [400, "outlook_bad_request"]] as const) {
      graphStatus = st;
      const r = await call("/outlook/profile", { headers: h });
      expect([r.status === 500 || r.status === 502 ? 502 : r.status, (await r.json() as any).error]).toEqual([st === 500 ? 502 : st, code]);
      if (st === 429) expect((await call("/outlook/profile", { headers: h })).headers.get("Retry-After")).toBe("7");
    }
    graphStatus = 401;
    expect((await call("/outlook/profile", { headers: h })).status).toBe(401);
    graphStatus = 200;
    expect((await call("/outlook/profile", { headers: h })).status).toBe(401); // session was removed
  });
  it("the token appears in no response body and no log line", async () => {
    const h = await rw();
    const bodies = [
      await (await call("/outlook/profile", { headers: h })).text(), await (await call("/outlook/conversations", { headers: h })).text(),
      await (await call("/outlook/conversations/cA", { headers: h })).text(), await (await post("/outlook/messages/m1/trash", undefined, h)).text(),
    ];
    for (const b of bodies) { expect(b).not.toContain(TOKEN); expect(b).not.toContain(REFRESH); }
    expect(JSON.stringify(errSpy.mock.calls)).not.toContain(TOKEN);
    expect(calls.some((c) => c.headers.Authorization === "Bearer " + TOKEN)).toBe(true);
  });
  it("revoke removes the session and makes no call to Microsoft (no revocation endpoint)", async () => {
    const h = await rw();
    calls.length = 0;
    expect((await post("/session/revoke", undefined, h)).status).toBe(200);
    expect(calls).toEqual([]);
    expect((await call("/outlook/profile", { headers: h })).status).toBe(401);
  });
});

describe("core: Outlook sessions", () => {
  it("lifetime = min(30 min, expires_in - 60 s); idle 5 min; hard expiry; vendor revoke hook called once", async () => {
    const s = setup();
    const a = await approvedTx(s, "outlook", "read", "Mail.Read");
    expect(a.res).toBe("ok");
    const c: any = await s.core.claim(a.id, a.secret);
    expect(c).toMatchObject({ app: "outlook", ttlMs: 30 * 60_000 });
    // short token: 10 min - 60 s
    const b = await approvedTx(s, "outlook", "read", "Mail.Read");
    (s.kv.m.get("t:" + b.id) as any).tokenLifeMs = 600_000;
    const c2: any = await s.core.claim(b.id, b.secret);
    expect(c2.ttlMs).toBe(540_000);
    s.clock.t += 5 * 60_000 + 1;
    expect(await s.core.auth(c.cap, "outlook")).toBeNull();
    expect(s.revoked.filter((r) => r.app === "outlook")).toHaveLength(1);
    expect(await s.core.auth(c2.cap, "outlook")).toBeNull(); // idle limit is 5 min for Outlook too
  });
  it("send slots belong to their own app", async () => {
    const s = setup();
    const a = await approvedTx(s, "outlook", "write", "Mail.ReadWrite Mail.Send");
    const c: any = await s.core.claim(a.id, a.secret);
    expect(await s.core.sendSlot(c.cap, "gmail")).toMatchObject({ ok: false });
    expect(await s.core.sendSlot(c.cap, "outlook")).toMatchObject({ ok: true, left: 9 });
    const r = await approvedTx(s, "outlook", "read", "Mail.Read");
    const rc: any = await s.core.claim(r.id, r.secret);
    expect(await s.core.sendSlot(rc.cap, "outlook")).toMatchObject({ ok: false });
  });
});
