// End-to-end tests of the HTTP router with a fake Durable Object and a fake Google/Spotify.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

import worker from "../src/index";
import { StoreCore } from "../src/core";
import { FakeKV } from "./helpers";
import { b64u, sha } from "../src/security";

const ORIGIN = "https://front.example";
const RELAY = "https://relay.example";
const SECRET_TOKEN = "ya29.SUPER-SECRET-ACCESS-TOKEN";

let core: StoreCore;
let env: any;
let calls: Array<{ url: string; init?: RequestInit }>;
let grantedScope: string;

beforeEach(() => {
  const kv = new FakeKV();
  core = new StoreCore(kv, {
    seal: async (p, aad) => `sealed:${aad}:${p}`,
    open: async (s, aad) => s.slice(`sealed:${aad}:`.length),
    revoke: () => {},
  });
  env = {
    STORE: { getByName: () => core },
    FRONTEND_ORIGIN: ORIGIN, FRONTEND_URL: ORIGIN + "/workspace/", TOKEN_KEY: "x",
    GOOGLE_CLIENT_ID: "gid", GOOGLE_CLIENT_SECRET: "gsecret", GOOGLE_REDIRECT_URI: RELAY + "/oauth/google/callback",
  };
  calls = [];
  vi.stubGlobal("fetch", async (url: any, init?: RequestInit) => {
    const u = String(url); calls.push({ url: u, init });
    if (u === "https://oauth2.googleapis.com/token")
      return Response.json({ access_token: SECRET_TOKEN, expires_in: 3600, scope: grantedScope, token_type: "Bearer" });
    if (u.endsWith("/labels/INBOX")) return Response.json({ messagesUnread: 3, messagesTotal: 10 });
    if (u === "https://accounts.spotify.com/api/token")
      return Response.json({ access_token: SECRET_TOKEN, refresh_token: "REFRESH-MUST-NOT-BE-KEPT", expires_in: 3600, scope: grantedScope, token_type: "Bearer" });
    if (u.endsWith("/messages/send")) return Response.json({ id: "sent1" });
    if (u.includes("/threads?")) return Response.json({ threads: [{ id: "t1" }], nextPageToken: null });
    if (u.includes("/threads/t1?format=metadata")) return Response.json({ id: "t1", snippet: "thanks!", messages: [
      { id: "m1", labelIds: ["INBOX", "UNREAD"], payload: { headers: [{ name: "From", value: '"Ada L" <ada@x.com>' }, { name: "Subject", value: "Plans" }, { name: "Date", value: "Mon, 1 Jan 2026 10:00:00 +0000" }] } },
      { id: "m2", labelIds: ["SENT"], payload: { headers: [{ name: "From", value: "me@x.com" }, { name: "Subject", value: "Re: Plans" }, { name: "Date", value: "Mon, 1 Jan 2026 11:00:00 +0000" }] } }] });
    if (u.includes("/threads/t1?format=full")) return Response.json({ id: "t1", messages: [
      { id: "m1", labelIds: ["INBOX"], payload: { mimeType: "text/plain", body: { data: btoa("hello") }, headers: [{ name: "From", value: "Ada <ada@x.com>" }, { name: "Subject", value: "Plans" }, { name: "To", value: "Me <me@x.com>, bob@y.com" }] } },
      { id: "m2", labelIds: ["SENT"], payload: { mimeType: "text/plain", body: { data: btoa("sure") }, headers: [{ name: "From", value: "me@x.com" }, { name: "To", value: "Ada <ada@x.com>" }] } }] });
    if (u.endsWith("/threads/t1/modify") || u.endsWith("/threads/t1/trash")) return Response.json({});
    return new Response("{}", { status: 404 });
  });
});

const call = (path: string, init: RequestInit & { origin?: string | null } = {}) => {
  const headers = new Headers(init.headers);
  if (init.origin !== null) headers.set("Origin", init.origin ?? ORIGIN);
  return worker.fetch(new Request(RELAY + path, { ...init, headers }), env);
};
const post = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
  call(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body), headers });

/** Full unlock through the HTTP layer. Returns everything the shared browser would hold. */
async function unlock(access: "read" | "write" = "read") {
  const secret = b64u(crypto.getRandomValues(new Uint8Array(32)));
  const start = await (await post("/link/start", { app: "gmail", access, claimHash: await sha(secret) })).json() as any;
  const info = await (await call("/link/info/" + start.id)).json() as any;
  const conf = await (await post("/link/confirm/" + start.id, { code: start.code })).json() as any;
  const auth = await call(`/oauth/google?tx=${start.id}&n=${conf.nonce}`, { origin: null, redirect: "manual" });
  const authUrl = new URL(auth.headers.get("Location")!);
  grantedScope = authUrl.searchParams.get("scope")!;
  const cb = await call(`/oauth/google/callback?code=abc&state=${encodeURIComponent(authUrl.searchParams.get("state")!)}`, { origin: null });
  return { start, info, secret, authUrl, cb, claim: () => post("/link/claim/" + start.id, undefined, { "X-Claim-Secret": secret }) };
}
const bearer = (cap: string) => ({ Authorization: "Bearer " + cap });

describe("router", () => {
  it("/health reports booleans only", async () => {
    const r = await call("/health", { origin: null });
    expect(await r.json()).toEqual({ ok: true, configured: { tokenKey: true, google: true, spotify: false, player: false } });
  });

  it("rejects API calls from other origins, and sets CORS only for the frontend", async () => {
    expect((await post("/link/start", {}, {})).headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    expect((await call("/link/info/x", { origin: "https://evil.example" })).status).toBe(403);
    expect((await call("/link/info/x", { origin: null })).status).toBe(403);
    const pre = await call("/link/start", { method: "OPTIONS" });
    expect(pre.headers.get("Access-Control-Allow-Headers")).toContain("X-Claim-Secret");
    expect(pre.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
  });

  it("Spotify tile reports not configured instead of failing later", async () => {
    const r = await post("/link/start", { app: "spotify", access: "write", claimHash: await sha("x") });
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ error: "app_not_configured" });
  });

  it("rejects bad start bodies", async () => {
    expect((await post("/link/start", { app: "gmail", access: "root", claimHash: "x" })).status).toBe(400);
    expect((await post("/link/start", { app: "nope" })).status).toBe(400);
    expect((await call("/link/start", { method: "POST", body: "not json" })).status).toBe(400);
  });

  it("full unlock: secure OAuth URL, claim secret required, token never reaches the browser", async () => {
    const u = await unlock("read");
    expect(JSON.stringify(u.info)).not.toContain(u.start.code); // F2
    expect(u.info.describe).toMatch(/Read your email/);
    // OAuth request hygiene
    expect(u.authUrl.origin + u.authUrl.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(u.authUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.authUrl.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/gmail.readonly");
    expect(u.authUrl.searchParams.has("access_type")).toBe(false);
    expect(u.authUrl.searchParams.has("include_granted_scopes")).toBe(false);
    expect(u.authUrl.searchParams.has("client_secret")).toBe(false);
    // callback redirects the phone back to the frontend
    expect(u.cb.status).toBe(302);
    expect(u.cb.headers.get("Location")).toBe(`${ORIGIN}/workspace/#/p/${u.start.id}/done`);
    // F1: someone who only knows the transaction id cannot claim or poll
    expect((await post("/link/claim/" + u.start.id)).status).toBe(409);
    expect(await (await call("/link/status/" + u.start.id)).json()).toEqual({ status: "expired" });
    // the real browser can
    expect(await (await call("/link/status/" + u.start.id, { headers: { "X-Claim-Secret": u.secret } })).json()).toEqual({ status: "approved" });
    const claimed = await (await u.claim()).json() as any;
    expect(claimed).toMatchObject({ app: "gmail", access: "read" });
    expect((await u.claim()).status).toBe(409); // single use
    // use the capability
    const prof = await call("/gmail/profile", { headers: bearer(claimed.cap) });
    const profText = await prof.text();
    expect(JSON.parse(profText)).toMatchObject({ unread: 3, total: 10, access: "read" });
    // the Google token was used server-side...
    expect(calls.some((c) => (c.init?.headers as any)?.Authorization === "Bearer " + SECRET_TOKEN)).toBe(true);
    // ...and appears in NO response body we produced
    expect(profText).not.toContain(SECRET_TOKEN);
    expect(u.cb.headers.get("Location")).not.toContain(SECRET_TOKEN);
    expect(JSON.stringify(claimed)).not.toContain(SECRET_TOKEN);
    // the token exchange used the client secret only server-side
    const ex = calls.find((c) => c.url.includes("oauth2.googleapis.com/token"))!;
    expect(String(ex.init!.body)).toContain("code_verifier=");
  });

  it("wrong code three times locks the transaction", async () => {
    const secret = "s".repeat(43);
    const start = await (await post("/link/start", { app: "gmail", access: "read", claimHash: await sha(secret) })).json() as any;
    const wrong = start.code === "000000" ? "111111" : "000000";
    expect((await post("/link/confirm/" + start.id, { code: wrong })).status).toBe(403);
    expect((await post("/link/confirm/" + start.id, { code: wrong })).status).toBe(403);
    expect((await post("/link/confirm/" + start.id, { code: wrong })).status).toBe(410);
    expect((await post("/link/confirm/" + start.id, { code: start.code })).status).toBe(410);
  });

  it("insufficient granted scope sends the phone to an error page and yields no session", async () => {
    const secret = b64u(crypto.getRandomValues(new Uint8Array(32)));
    const start = await (await post("/link/start", { app: "gmail", access: "write", claimHash: await sha(secret) })).json() as any;
    const conf = await (await post("/link/confirm/" + start.id, { code: start.code })).json() as any;
    const auth = await call(`/oauth/google?tx=${start.id}&n=${conf.nonce}`, { origin: null });
    grantedScope = "https://www.googleapis.com/auth/gmail.readonly"; // user unticked the write permission
    const cb = await call(`/oauth/google/callback?code=abc&state=${encodeURIComponent(new URL(auth.headers.get("Location")!).searchParams.get("state")!)}`, { origin: null });
    expect(cb.headers.get("Location")).toContain("error?r=scope");
    expect((await post("/link/claim/" + start.id, undefined, { "X-Claim-Secret": secret })).status).toBe(409);
  });

  it("denied / bad state / replayed callback never create a session", async () => {
    const cb = await call("/oauth/google/callback?code=abc&state=forged.state", { origin: null });
    expect(cb.headers.get("Location")).toContain("error?r=state");
    const u = await unlock();
    const replay = await call(`/oauth/google/callback?code=abc&state=${encodeURIComponent(u.authUrl.searchParams.get("state")!)}`, { origin: null });
    expect(replay.headers.get("Location")).toContain("error?r=state");
  });

  it("read-only sessions cannot send, star, trash", async () => {
    const u = await unlock("read");
    const { cap } = await (await u.claim()).json() as any;
    expect((await post("/gmail/send", { to: ["a@b.com"], subject: "s", body: "b" }, bearer(cap))).status).toBe(403);
    expect((await post("/gmail/messages/abc/action", { action: "star" }, bearer(cap))).status).toBe(403);
    expect((await post("/gmail/messages/abc/trash", undefined, bearer(cap))).status).toBe(403);
    expect(calls.some((c) => c.url.includes("/messages/send"))).toBe(false);
  });

  it("write sessions can send; injected recipients are rejected; send count is capped", async () => {
    const u = await unlock("write");
    const { cap } = await (await u.claim()).json() as any;
    const bad = await post("/gmail/send", { to: ["a@b.com\r\nBcc: x@y.com"], subject: "s", body: "b" }, bearer(cap));
    expect(bad.status).toBe(400);
    const ok = await post("/gmail/send", { to: ["a@b.com"], subject: "Hi", body: "Hello" }, bearer(cap));
    expect(ok.status).toBe(200);
    const sent = calls.find((c) => c.url.endsWith("/messages/send"))!;
    const raw = JSON.parse(String(sent.init!.body)).raw as string;
    expect(atob(raw.replace(/-/g, "+").replace(/_/g, "/"))).toContain("To: a@b.com");
    // cap: 10 per session (1 used). Bypass the per-minute limiter to reach it.
    for (let i = 0; i < 9; i++) { core.hit("x", 1, 1); (core as any).rl.clear(); expect((await post("/gmail/send", { to: ["a@b.com"], subject: "s", body: "b" }, bearer(cap))).status).toBe(200); }
    (core as any).rl.clear();
    const over = await post("/gmail/send", { to: ["a@b.com"], subject: "s", body: "b" }, bearer(cap));
    expect(over.status).toBe(429);
    expect(await over.json()).toEqual({ error: "send_limit" });
  });

  it("a Gmail capability is useless on Spotify routes", async () => {
    const u = await unlock("write");
    const { cap } = await (await u.claim()).json() as any;
    expect((await call("/spotify/player", { headers: bearer(cap) })).status).toBe(401);
    expect((await post("/spotify/pause", undefined, bearer(cap))).status).toBe(401);
  });

  it("revoke kills the capability", async () => {
    const u = await unlock();
    const { cap } = await (await u.claim()).json() as any;
    expect((await post("/session/revoke", undefined, bearer(cap))).status).toBe(200);
    expect((await call("/gmail/profile", { headers: bearer(cap) })).status).toBe(401);
  });

  it("missing/garbage capability is 401; non-string bodies are 400", async () => {
    expect((await call("/gmail/profile")).status).toBe(401);
    expect((await call("/gmail/profile", { headers: bearer("short") })).status).toBe(401);
    const u = await unlock("write");
    const { cap } = await (await u.claim()).json() as any;
    expect((await post("/gmail/send", ["array"], bearer(cap))).status).toBe(400);
  });

  it("lists conversations per tab (Promotions = INBOX + CATEGORY_PROMOTIONS) and summarises threads", async () => {
    const u = await unlock("read");
    const { cap } = await (await u.claim()).json() as any;
    const r = await call("/gmail/threads?label=PROMOTIONS", { headers: bearer(cap) });
    const j = await r.json() as any;
    const listCall = calls.find((c) => c.url.includes("/threads?"))!;
    expect(new URL(listCall.url).searchParams.getAll("labelIds")).toEqual(["INBOX", "CATEGORY_PROMOTIONS"]);
    expect(j.threads[0]).toMatchObject({ id: "t1", subject: "Plans", count: 2, unread: true, senders: ["Ada L", "me"] });
    expect((await call("/gmail/threads?label=BOGUS", { headers: bearer(cap) })).status).toBe(400);
    expect((await call("/gmail/threads?label=constructor", { headers: bearer(cap) })).status).toBe(400);
  });

  it("returns a whole conversation with sent flags and parsed recipients", async () => {
    const u = await unlock("read");
    const { cap } = await (await u.claim()).json() as any;
    const j = await (await call("/gmail/threads/t1", { headers: bearer(cap) })).json() as any;
    expect(j.count).toBe(2);
    expect(j.messages.map((m: any) => m.text)).toEqual(["hello", "sure"]);
    expect(j.messages[0]).toMatchObject({ fromAddr: "ada@x.com", toAddrs: ["me@x.com", "bob@y.com"], sent: false });
    expect(j.messages[1].sent).toBe(true);
  });

  it("thread actions need a write session and use the same whitelist", async () => {
    const ro = await unlock("read");
    const roCap = (await (await ro.claim()).json() as any).cap;
    expect((await post("/gmail/threads/t1/action", { action: "archive" }, bearer(roCap))).status).toBe(403);
    const rw = await unlock("write");
    const cap = (await (await rw.claim()).json() as any).cap;
    expect((await post("/gmail/threads/t1/action", { action: "archive" }, bearer(cap))).status).toBe(200);
    expect((await post("/gmail/threads/t1/action", { action: "delete" }, bearer(cap))).status).toBe(400);
    expect((await post("/gmail/threads/t1/trash", undefined, bearer(cap))).status).toBe(200);
  });

  it("fails closed without TOKEN_KEY", async () => {
    env.TOKEN_KEY = "";
    expect((await post("/link/start", {})).status).toBe(500);
  });
});

// ---------------- v2.1: Spotify web player on an isolated origin ----------------
const PLAYER = "https://player.example";
describe("spotify web player (isolated origin)", () => {
  beforeEach(() => {
    env = { ...env, SPOTIFY_CLIENT_ID: "sid", SPOTIFY_CLIENT_SECRET: "ssecret", SPOTIFY_REDIRECT_URI: RELAY + "/oauth/spotify/callback",
      PLAYER_ORIGIN: PLAYER, PLAYER_URL: PLAYER + "/player/" };
  });
  const asPlayer = (path: string, init: RequestInit = {}) => call(path, { ...init, origin: PLAYER });
  const playerPost = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
    asPlayer(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body), headers });

  async function unlockStream(scope?: string) {
    const secret = b64u(crypto.getRandomValues(new Uint8Array(32)));
    const start = await (await playerPost("/link/start", { app: "spotify", access: "stream", claimHash: await sha(secret) })).json() as any;
    const conf = await (await playerPost("/link/confirm/" + start.id, { code: start.code })).json() as any;
    const auth = await call(`/oauth/spotify?tx=${start.id}&n=${conf.nonce}`, { origin: null });
    const authUrl = new URL(auth.headers.get("Location")!);
    grantedScope = scope ?? authUrl.searchParams.get("scope")!;
    const cb = await call(`/oauth/spotify/callback?code=abc&state=${encodeURIComponent(authUrl.searchParams.get("state")!)}`, { origin: null });
    return { start, secret, authUrl, cb, hdr: { "X-Claim-Secret": secret } };
  }

  it("hands the token over exactly once, keeps no session, and never keeps the refresh token", async () => {
    const u = await unlockStream();
    expect(u.authUrl.searchParams.get("scope")).toBe("streaming user-read-email user-read-private user-read-playback-state user-modify-playback-state");
    expect(u.authUrl.searchParams.has("include_granted_scopes")).toBe(false);
    // the phone is sent back to the PLAYER site, not the workspace
    expect(u.cb.headers.get("Location")).toBe(`${PLAYER}/player/#/p/${u.start.id}/done`);
    // the workspace origin can neither poll-claim it nor start one
    expect((await post("/link/claim/" + u.start.id, undefined, u.hdr)).status).toBe(409);
    // claim: only from the player origin, only with the claim secret
    expect((await playerPost("/link/claim/" + u.start.id)).status).toBe(409);
    const r = await playerPost("/link/claim/" + u.start.id, undefined, u.hdr);
    expect(r.status).toBe(200);
    const j = await r.json() as any;
    expect(j).toMatchObject({ token: SECRET_TOKEN, app: "spotify", access: "stream" });
    expect(j.ttlMs).toBe(3_540_000);
    expect((await playerPost("/link/claim/" + u.start.id, undefined, u.hdr)).status).toBe(409); // single use
    // the Relay kept nothing: no session, no token, no refresh token, in storage
    const stored = JSON.stringify([...(core as any).kv.m]);
    expect(stored).not.toContain("REFRESH-MUST-NOT-BE-KEPT");
    expect(stored).not.toContain(SECRET_TOKEN);
    expect([...(core as any).kv.m.keys()].some((k: string) => k.startsWith("s:"))).toBe(false);
    // and the refresh token never reached the browser either
    expect(JSON.stringify(j)).not.toContain("REFRESH");
  });

  it("origin rules: workspace cannot start a stream, player cannot start anything else", async () => {
    const h = await sha("x");
    expect((await post("/link/start", { app: "spotify", access: "stream", claimHash: h })).status).toBe(403);
    expect((await playerPost("/link/start", { app: "spotify", access: "write", claimHash: h })).status).toBe(403);
    expect((await playerPost("/link/start", { app: "gmail", access: "read", claimHash: h })).status).toBe(403);
    expect((await playerPost("/link/start", { app: "gmail", access: "stream", claimHash: h })).status).toBe(400); // gmail has no stream scopes
  });

  it("player origin cannot reach Gmail, Spotify remote control or session revoke", async () => {
    const g = await unlock("write");
    const { cap } = await (await g.claim()).json() as any;
    for (const [path, init] of [["/gmail/profile", { headers: bearer(cap) }], ["/spotify/player", { headers: bearer(cap) }], ["/session/revoke", { method: "POST", headers: bearer(cap) }]] as const)
      expect((await asPlayer(path, init as RequestInit)).status).toBe(403);
  });

  it("CORS echoes exactly the calling allowed origin and rejects others", async () => {
    expect((await asPlayer("/link/info/x")).headers.get("Access-Control-Allow-Origin")).toBe(PLAYER);
    expect((await call("/link/info/x", { origin: "https://evil.example" })).status).toBe(403);
    const pre = await call("/link/start", { method: "OPTIONS", origin: PLAYER });
    expect(pre.headers.get("Access-Control-Allow-Origin")).toBe(PLAYER);
  });

  it("fails closed when the player origin equals the workspace origin, or is not configured", async () => {
    env.PLAYER_ORIGIN = ORIGIN;
    const same = await post("/link/start", { app: "spotify", access: "stream", claimHash: await sha("x") });
    expect(same.status).toBe(503); expect(await same.json()).toEqual({ error: "player_not_isolated" });
    env.PLAYER_ORIGIN = ""; env.PLAYER_URL = "";
    const off = await post("/link/start", { app: "spotify", access: "stream", claimHash: await sha("x") });
    expect(off.status).toBe(503); expect(await off.json()).toEqual({ error: "player_not_configured" });
    // with the same-origin config the "player origin" is not honoured at all
    env.PLAYER_ORIGIN = ORIGIN; env.PLAYER_URL = ORIGIN + "/player/";
    expect((await call("/health", { origin: null }).then((r) => r.json()) as any).configured.player).toBe(false);
  });

  it("a missing scope (user unticked something) yields no token", async () => {
    const u = await unlockStream("user-read-email user-read-private");
    expect(u.cb.headers.get("Location")).toContain("error?r=scope");
    expect((await playerPost("/link/claim/" + u.start.id, undefined, u.hdr)).status).toBe(409);
  });

  it("/health reports the player as configured", async () => {
    expect(((await call("/health", { origin: null }).then((r) => r.json())) as any).configured).toMatchObject({ spotify: true, player: true });
  });
});

