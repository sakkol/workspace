// v3.1: Google Tasks + the Google bundle (one sign-in for Gmail + Tasks).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

import worker from "../src/index";
import { StoreCore } from "../src/core";
import { FakeKV, setup, approvedTx, CTX, newSecret } from "./helpers";
import { b64u, sha } from "../src/security";
import { APPS, bundleScopes, makeBundle } from "../src/apps";
import { taskFields, taskOut, validDate } from "../src/tasks";

const GMAIL_R = "https://www.googleapis.com/auth/gmail.readonly", GMAIL_W = "https://www.googleapis.com/auth/gmail.modify";
const TASKS_R = "https://www.googleapis.com/auth/tasks.readonly", TASKS_W = "https://www.googleapis.com/auth/tasks";

// ---------------------------------------------------------------- bundle: core
describe("bundle validation", () => {
  it("accepts Gmail + Tasks, at each access level, in either order", () => {
    expect(makeBundle({ app: "gmail", access: "read" }, [{ app: "tasks", access: "write" }])).toEqual([{ app: "gmail", access: "read" }, { app: "tasks", access: "write" }]);
    expect(makeBundle({ app: "tasks", access: "read" }, [{ app: "gmail", access: "write" }])).toHaveLength(2);
    expect(makeBundle({ app: "gmail", access: "read" }, undefined)).toEqual([{ app: "gmail", access: "read" }]);
    expect(bundleScopes(makeBundle({ app: "gmail", access: "read" }, [{ app: "tasks", access: "write" }])!)).toBe(`${GMAIL_R} ${TASKS_W}`);
  });
  it("rejects other vendors, duplicates, streaming, unknown apps, junk shapes", async () => {
    const s = setup(); const { hash } = await newSecret();
    const bad: unknown[] = [
      [{ app: "outlook", access: "read" }], [{ app: "spotify", access: "write" }], [{ app: "gmail", access: "read" }], [{ app: "tasks", access: "read" }, { app: "tasks", access: "read" }],
      [{ app: "tasks", access: "stream" }], [{ app: "nope", access: "read" }], [{ app: "tasks", access: "admin" }], [{ app: "constructor", access: "read" }], [],
      "tasks", { app: "tasks", access: "read" }, [null], [[]], [{ app: "tasks" }], Array(5).fill({ app: "tasks", access: "read" }), 7, [{ app: "tasks", access: "read", extra: 1 }, "x"],
    ];
    for (const also of bad) expect([also, await s.core.newTx("gmail", "read", hash, CTX, also)]).toEqual([also, { error: "bad_request" }]);
    // Outlook / Spotify as the PRIMARY app cannot take a bundle either
    expect(await s.core.newTx("outlook", "read", hash, CTX, [{ app: "tasks", access: "read" }])).toEqual({ error: "bad_request" });
    expect(await s.core.newTx("spotify", "write", hash, CTX, [{ app: "tasks", access: "read" }])).toEqual({ error: "bad_request" });
    expect(await s.core.newTx("gmail", "stream", hash, CTX, [{ app: "tasks", access: "read" }])).toEqual({ error: "bad_request" });
  });
  it("extra keys on a bundle item are ignored, not stored", async () => {
    const s = setup(); const { hash } = await newSecret();
    const tx: any = await s.core.newTx("gmail", "read", hash, CTX, [{ app: "tasks", access: "read", scope: "https://evil/all" } as any]);
    const info: any = await s.core.info(tx.id);
    expect(info.apps).toHaveLength(2);
    expect(JSON.stringify([...s.kv.m.values()])).not.toContain("evil");
  });
});

describe("bundle unlock (core)", () => {
  const ALSO = [{ app: "tasks" as const, access: "write" as const }];
  it("info lists EVERY app and access level; single unlocks keep the old shape", async () => {
    const s = setup(); const { hash } = await newSecret();
    const tx: any = await s.core.newTx("gmail", "read", hash, CTX, ALSO);
    const i: any = await s.core.info(tx.id);
    expect(i.label).toBe("Gmail + Google Tasks");
    expect(i.apps.map((a: any) => [a.app, a.access])).toEqual([["gmail", "read"], ["tasks", "write"]]);
    expect(i.apps[1].describe).toMatch(/add, edit and complete/i);
    expect(i.vendor).toBe("google");
    const t2: any = await s.core.newTx("gmail", "read", hash, CTX);
    expect((await s.core.info(t2.id) as any).apps).toHaveLength(1);
  });
  it("happy path: one token, one session and one capability per app, each bound to its own app", async () => {
    const s = setup();
    const a = await approvedTx(s, "gmail", "read", undefined, ALSO);
    expect(a.res).toBe("ok");
    const c: any = await s.core.claim(a.id, a.secret);
    expect(Object.keys(c.caps).sort()).toEqual(["gmail", "tasks"]);
    expect(c.caps.gmail.cap).not.toBe(c.caps.tasks.cap);
    expect(c.caps.gmail.access).toBe("read"); expect(c.caps.tasks.access).toBe("write");
    expect(c.cap).toBe(c.caps.gmail.cap); expect(c.app).toBe("gmail"); // legacy top-level fields = primary app
    expect(await s.core.auth(c.caps.gmail.cap, "gmail")).toMatchObject({ access: "read" });
    expect(await s.core.auth(c.caps.tasks.cap, "tasks")).toMatchObject({ access: "write" });
    // wrong-app capability looks like an expired session
    expect(await s.core.auth(c.caps.gmail.cap, "tasks")).toBeNull();
    expect(await s.core.auth(c.caps.tasks.cap, "gmail")).toBeNull();
    expect(await s.core.auth(c.caps.tasks.cap, "outlook")).toBeNull();
    // single-use
    expect(await s.core.claim(a.id, a.secret)).toBeNull();
  });
  it("the vendor is sent the exact union of scopes", async () => {
    const s = setup(); const { hash } = await newSecret();
    const tx: any = await s.core.newTx("tasks", "write", hash, CTX, [{ app: "gmail", access: "write" }]);
    const conf: any = await s.core.confirm(tx.id, tx.code);
    const b: any = await s.core.begin(tx.id, conf.nonce);
    expect(b.scope).toBe(`${TASKS_W} ${GMAIL_W}`);
    expect(b.scope).not.toMatch(/drive|calendar|contacts|readonly/);
  });
  it("a partial scope grant fails the WHOLE transaction and revokes the token", async () => {
    const s = setup();
    for (const granted of [GMAIL_R, TASKS_W, "", `${GMAIL_R} ${TASKS_R}`]) {
      s.revoked.length = 0;
      const a = await approvedTx(s, "gmail", "read", granted, ALSO);
      expect(a.res).toBe("scope");
      expect(s.revoked).toHaveLength(1);
      expect(await s.core.claim(a.id, a.secret)).toBeNull();
    }
    const ok = await approvedTx(s, "gmail", "read", `${GMAIL_R} ${TASKS_W} openid email`, ALSO); // extra granted scopes are tolerated
    expect(ok.res).toBe("ok");
  });
  it("locking one app keeps the shared token alive; the LAST one revokes it (both orders)", async () => {
    for (const order of [["gmail", "tasks"], ["tasks", "gmail"]] as const) {
      const s = setup();
      const a = await approvedTx(s, "gmail", "write", undefined, ALSO);
      const c: any = await s.core.claim(a.id, a.secret);
      await s.core.revoke(c.caps[order[0]].cap);
      expect(s.revoked).toHaveLength(0);
      expect(await s.core.auth(c.caps[order[1]].cap, order[1])).not.toBeNull(); // the other app still works
      await s.core.revoke(c.caps[order[1]].cap);
      expect(s.revoked).toHaveLength(1);
      expect(s.revoked[0].token).toBe("TOKEN-gmail");
      expect(s.kv.m.size).toBe(1); // only the (consumed) transaction record is left
    }
  });
  it("one app expiring (idle) while the other continues; then the token is revoked exactly once", async () => {
    const s = setup();
    const a = await approvedTx(s, "gmail", "write", undefined, ALSO);
    const c: any = await s.core.claim(a.id, a.secret);
    s.clock.t += 4 * 60_000;
    expect(await s.core.auth(c.caps.tasks.cap, "tasks")).not.toBeNull(); // human activity on Tasks only
    s.clock.t += 2 * 60_000; // Gmail has now been idle for 6 min, Tasks for 2
    expect(await s.core.auth(c.caps.gmail.cap, "gmail")).toBeNull();
    expect(s.revoked).toHaveLength(0); // Tasks is still using the token
    expect(await s.core.auth(c.caps.tasks.cap, "tasks")).not.toBeNull();
    s.clock.t += 6 * 60_000;
    expect(await s.core.auth(c.caps.tasks.cap, "tasks")).toBeNull();
    expect(s.revoked).toHaveLength(1);
  });
  it("both expire together: the cleanup alarm revokes once, not twice", async () => {
    const s = setup();
    const a = await approvedTx(s, "gmail", "read", undefined, ALSO);
    await s.core.claim(a.id, a.secret);
    s.clock.t += 31 * 60_000;
    await s.core.alarm();
    expect(s.revoked).toHaveLength(1);
    expect([...s.kv.m.keys()].filter((k) => k.startsWith("s:"))).toEqual([]);
  });
  it("session lifetime follows the shared token: min(30 min, life - 60 s) for each", async () => {
    const s = setup();
    const a = await approvedTx(s, "gmail", "read", undefined, ALSO);
    (s.kv.m.get("t:" + a.id) as any).tokenLifeMs = 600_000;
    const c: any = await s.core.claim(a.id, a.secret);
    expect(c.caps.gmail.ttlMs).toBe(540_000); expect(c.caps.tasks.ttlMs).toBe(540_000);
  });
  it("the sealed token copies are per session (own AAD) and never plain in storage", async () => {
    const s = setup();
    const a = await approvedTx(s, "gmail", "read", undefined, ALSO);
    await s.core.claim(a.id, a.secret);
    const sessions = [...s.kv.m].filter(([k]) => k.startsWith("s:"));
    expect(sessions).toHaveLength(2);
    for (const [k, v] of sessions) expect((v as any).token).toBe(`sealed:${k}:TOKEN-gmail`);
    expect(new Set(sessions.map(([, v]) => (v as any).group)).size).toBe(1);
  });
});

describe("Tasks write allowance (core)", () => {
  it("only write sessions of the right app, and a per-session limit", async () => {
    const s = setup();
    const a = await approvedTx(s, "gmail", "read", undefined, [{ app: "tasks", access: "write" }]);
    const c: any = await s.core.claim(a.id, a.secret);
    expect(await s.core.writeSlot(c.caps.tasks.cap, "tasks", 2)).toMatchObject({ ok: true, left: 1 });
    expect(await s.core.writeSlot(c.caps.tasks.cap, "gmail", 2)).toMatchObject({ ok: false });
    expect(await s.core.writeSlot(c.caps.gmail.cap, "gmail", 2)).toMatchObject({ ok: false }); // read-only Gmail
    expect(await s.core.writeSlot(c.caps.tasks.cap, "tasks", 2)).toMatchObject({ ok: true, left: 0 });
    expect(await s.core.writeSlot(c.caps.tasks.cap, "tasks", 2)).toEqual({ ok: false, reason: "write_limit" });
    const r = await approvedTx(s, "tasks", "read");
    const rc: any = await s.core.claim(r.id, r.secret);
    expect(await s.core.writeSlot(rc.cap, "tasks")).toMatchObject({ ok: false });
  });
});

// ---------------------------------------------------------------- field validation
describe("task fields", () => {
  it("dates", () => {
    for (const d of ["2026-10-01", "2028-02-29", "1970-01-01"]) expect(validDate(d)).toBe(true);
    for (const d of ["2026-02-30", "2026-13-01", "2026-1-1", "2026-10-01T00:00:00Z", "1969-12-31", "2101-01-01", "", null, 5, "today", "2026-10-01\n"]) expect([d, validDate(d)]).toEqual([d, false]);
  });
  it("create needs a single-line title; only known fields survive; due becomes an RFC 3339 date", () => {
    expect(taskFields({ title: " Buy\nmilk ", notes: "2 l", due: "2026-10-05", parent: "x", id: "y", status: undefined, links: [1] }, true))
      .toEqual({ title: "Buy milk", notes: "2 l", due: "2026-10-05T00:00:00.000Z" });
    for (const b of [{}, { title: "" }, { title: "   " }, { title: 5 }, { title: "x".repeat(501) }, { title: "a", notes: 5 }, { title: "a", notes: "n".repeat(8001) }, { title: "a", due: "soon" }, { title: "a", status: "completed" }])
      expect(() => taskFields(b as any, true)).toThrow();
  });
  it("update: status, reopening clears `completed`, due can be cleared, empty updates fail", () => {
    expect(taskFields({ status: "completed" }, false)).toEqual({ status: "completed" });
    expect(taskFields({ status: "needsAction" }, false)).toEqual({ status: "needsAction", completed: null });
    expect(taskFields({ due: null }, false)).toEqual({ due: null });
    expect(taskFields({ due: "" }, false)).toEqual({ due: null });
    for (const b of [{}, { foo: 1 }, { status: "deleted" }, { status: "" }, { title: "" }]) expect(() => taskFields(b as any, false)).toThrow();
  });
  it("output is normalised and bounded", () => {
    expect(taskOut({ id: "a1", title: "T", notes: "N", status: "completed", due: "2026-10-05T00:00:00.000Z", parent: "p 1", extra: "x", webViewLink: "http://evil" }))
      .toEqual({ id: "a1", title: "T", notes: "N", status: "completed", due: "2026-10-05", parent: "", updated: "" });
    expect(taskOut({ status: "weird" }).status).toBe("needsAction");
    expect(taskOut({ title: "x".repeat(9000) }).title).toHaveLength(500);
  });
});

// ---------------------------------------------------------------- router
const ORIGIN = "https://front.example", RELAY = "https://relay.example";
const TOKEN = "ya29.SUPER-SECRET-GOOGLE-ACCESS-TOKEN";
let core: StoreCore, env: any, calls: Array<{ url: string; method: string; body?: string }>, revokedTokens: string[], googleStatus: number, grantedScope: string | null;

const TASKS = [
  { id: "t1", title: "Open task", notes: "n1", status: "needsAction", due: "2026-10-05T00:00:00.000Z", updated: "2026-09-01T00:00:00Z", webViewLink: "http://evil" },
  { id: "t2", title: "Sub", status: "needsAction", parent: "t1" },
  { id: "t3", title: "Done", status: "completed", completed: "2026-09-02T00:00:00Z" },
];
beforeEach(() => {
  revokedTokens = []; calls = []; googleStatus = 200; grantedScope = null;
  core = new StoreCore(new FakeKV(), { seal: async (p, aad) => `sealed:${aad}:${p}`, open: async (s, aad) => s.slice(`sealed:${aad}:`.length), revoke: (_a, t) => { revokedTokens.push(t); } });
  env = {
    STORE: { getByName: () => core }, FRONTEND_ORIGIN: ORIGIN, FRONTEND_URL: ORIGIN + "/workspace/", TOKEN_KEY: "x",
    GOOGLE_CLIENT_ID: "gid", GOOGLE_CLIENT_SECRET: "gsecret", GOOGLE_REDIRECT_URI: RELAY + "/oauth/google/callback",
    MICROSOFT_CLIENT_ID: "mid", MICROSOFT_CLIENT_SECRET: "msecret", MICROSOFT_REDIRECT_URI: RELAY + "/oauth/microsoft/callback",
  };
  vi.stubGlobal("fetch", async (url: any, init?: RequestInit) => {
    const u = String(url), method = init?.method ?? "GET";
    calls.push({ url: u, method, body: init?.body === undefined ? undefined : String(init.body) });
    if (u === "https://oauth2.googleapis.com/token") return Response.json({ access_token: TOKEN, expires_in: 3599, scope: grantedScope, token_type: "Bearer" });
    if (u.startsWith("https://tasks.googleapis.com/tasks/v1")) {
      if (googleStatus !== 200) return new Response("{}", { status: googleStatus, headers: googleStatus === 429 ? { "Retry-After": "9" } : {} });
      if (u.includes("/users/@me/lists")) return Response.json({ items: [{ id: "L1", title: "My Tasks" }, { id: "bad id!", title: "x" }, { id: "L2", title: "Work" }] });
      if (method === "GET") return Response.json({ items: TASKS, nextPageToken: u.includes("pageToken") ? undefined : "NEXT_1" });
      if (method === "POST") return Response.json({ id: "new1", ...JSON.parse(String(init!.body)), status: "needsAction" });
      if (method === "PATCH") return Response.json({ id: "t1", title: "Open task", ...JSON.parse(String(init!.body)) });
    }
    return new Response("{}", { status: 404 });
  });
});
afterEach(() => expect(calls.some((c) => c.method === "DELETE")).toBe(false)); // a Tasks task is never deleted

const call = (path: string, init: RequestInit & { origin?: string | null } = {}) => {
  const headers = new Headers(init.headers);
  if (init.origin !== null) headers.set("Origin", init.origin ?? ORIGIN);
  return worker.fetch(new Request(RELAY + path, { ...init, headers }), env);
};
const post = (path: string, body?: unknown, headers: Record<string, string> = {}) => call(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body), headers });
const bearer = (cap: string) => ({ Authorization: "Bearer " + cap });

async function unlock(app: string, access: string, also?: unknown, grant?: string) {
  const secret = b64u(crypto.getRandomValues(new Uint8Array(32)));
  const startRes = await post("/link/start", { app, access, also, claimHash: await sha(secret) });
  const start = await startRes.json() as any;
  if (startRes.status !== 200) return { startRes, start } as any;
  const info = await (await call("/link/info/" + start.id)).json() as any;
  const conf = await (await post("/link/confirm/" + start.id, { code: start.code })).json() as any;
  const auth = await call(`/oauth/google?tx=${start.id}&n=${conf.nonce}`, { origin: null });
  const authUrl = new URL(auth.headers.get("Location")!);
  grantedScope = grant ?? authUrl.searchParams.get("scope")!;
  const cb = await call(`/oauth/google/callback?code=abc&state=${encodeURIComponent(authUrl.searchParams.get("state")!)}`, { origin: null });
  const claim = () => post("/link/claim/" + start.id, undefined, { "X-Claim-Secret": secret });
  return { startRes, start, info, authUrl, cb, claim };
}
const both = async (g: string, t: string) => { const u = await unlock("gmail", g, [{ app: "tasks", access: t }]); const c = await (await u.claim()).json() as any; return { u, c, gm: bearer(c.caps.gmail.cap), tk: bearer(c.caps.tasks.cap) }; };
const tasksOnly = async (access: string) => { const u = await unlock("tasks", access); return bearer(((await (await u.claim()).json()) as any).cap); };

describe("bundle unlock through the Relay", () => {
  it("authorize URL: union scopes only, PKCE, no include_granted_scopes / offline access; phone info lists both apps", async () => {
    const u = await unlock("gmail", "read", [{ app: "tasks", access: "write" }]);
    expect(u.info.apps.map((a: any) => a.label)).toEqual(["Gmail", "Google Tasks"]);
    const q = u.authUrl.searchParams;
    expect(q.get("scope")).toBe(`${GMAIL_R} ${TASKS_W}`);
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.has("include_granted_scopes")).toBe(false);
    expect(u.cb.headers.get("Location")).toContain("/done");
    const claimed = await (await u.claim()).json() as any;
    expect(Object.keys(claimed.caps).sort()).toEqual(["gmail", "tasks"]);
    expect(JSON.stringify(claimed)).not.toContain(TOKEN);
  });
  it("a single Tasks unlock asks only for the Tasks scope", async () => {
    const u = await unlock("tasks", "read");
    expect(u.authUrl.searchParams.get("scope")).toBe(TASKS_R);
  });
  it("Gmail read + Tasks read", async () => {
    const u = await unlock("gmail", "read", [{ app: "tasks", access: "read" }]);
    expect(u.authUrl.searchParams.get("scope")).toBe(`${GMAIL_R} ${TASKS_R}`);
  });
  it("a missing scope (Tasks unticked) fails the whole unlock and nothing is claimable", async () => {
    const u = await unlock("gmail", "read", [{ app: "tasks", access: "read" }], GMAIL_R);
    expect(u.cb.headers.get("Location")).toContain("error?r=scope");
    expect((await u.claim()).status).toBe(409);
    expect(revokedTokens).toEqual([TOKEN]);
  });
  it("cross-vendor and malformed bundles are refused at /link/start", async () => {
    for (const also of [[{ app: "outlook", access: "read" }], [{ app: "spotify", access: "write" }], [{ app: "gmail", access: "read" }], "tasks", [{ app: "tasks", access: "stream" }]]) {
      const u = await unlock("gmail", "read", also);
      expect([JSON.stringify(also), u.startRes.status]).toEqual([JSON.stringify(also), 400]);
    }
    expect((await unlock("outlook", "read", [{ app: "tasks", access: "read" }])).startRes.status).toBe(400);
  });
  it("the two capabilities are not interchangeable", async () => {
    const { gm, tk } = await both("write", "write");
    expect((await call("/gmail/profile", { headers: tk })).status).toBe(401);
    expect((await call("/tasks/lists", { headers: gm })).status).toBe(401);
    expect((await post("/gmail/send", { to: ["a@b.com"], subject: "s", body: "b" }, tk)).status).toBe(401);
    expect((await post("/tasks/lists/L1/tasks", { title: "x" }, gm)).status).toBe(401);
    for (const path of ["/outlook/profile", "/spotify/player"]) { expect((await call(path, { headers: tk })).status).toBe(401); expect((await call(path, { headers: gm })).status).toBe(401); }
    expect((await call("/tasks/lists", { headers: tk })).status).toBe(200);
  });
  it("Lock: the Google token survives until the LAST app of the bundle is locked", async () => {
    const { gm, tk } = await both("read", "read");
    expect((await post("/session/revoke", undefined, gm)).status).toBe(200);
    expect(revokedTokens).toEqual([]);
    expect((await call("/gmail/profile", { headers: gm })).status).toBe(401);
    expect((await call("/tasks/lists", { headers: tk })).status).toBe(200);
    await post("/session/revoke", undefined, tk);
    expect(revokedTokens).toEqual([TOKEN]);
    expect((await call("/tasks/lists", { headers: tk })).status).toBe(401);
  });
  it("Google rejecting the token ends only the session that hit it", async () => {
    const { gm, tk } = await both("read", "read");
    googleStatus = 401;
    expect((await call("/tasks/lists", { headers: tk })).status).toBe(401);
    googleStatus = 200;
    expect((await call("/tasks/lists", { headers: tk })).status).toBe(401); // removed
    expect(revokedTokens).toEqual([]); // Gmail is still registered, so the shared token is not revoked yet
    expect((await call("/gmail/profile", { headers: gm })).status).not.toBe(401);
  });
});

describe("Tasks routes", () => {
  it("401 without a capability; workspace origin only", async () => {
    expect((await call("/tasks/lists")).status).toBe(401);
    expect((await call("/tasks/lists", { headers: bearer("short") })).status).toBe(401);
    expect((await call("/tasks/lists", { origin: "https://evil.example" })).status).toBe(403);
  });
  it("lists: ids are validated before they are returned", async () => {
    const h = await tasksOnly("read");
    expect(await (await call("/tasks/lists", { headers: h })).json()).toEqual({ lists: [{ id: "L1", title: "My Tasks" }, { id: "L2", title: "Work" }] });
  });
  it("tasks: open by default; completed only on request (with showHidden); output is normalised; no links", async () => {
    const h = await tasksOnly("read");
    const open = await (await call("/tasks/lists/L1/tasks", { headers: h })).json() as any;
    expect(open.tasks.map((t: any) => t.id)).toEqual(["t1", "t2"]);
    expect(open.tasks[0]).toEqual({ id: "t1", title: "Open task", notes: "n1", status: "needsAction", due: "2026-10-05", parent: "", updated: "2026-09-01T00:00:00Z" });
    expect(open.tasks[1].parent).toBe("t1");
    expect(JSON.stringify(open)).not.toMatch(/evil|webViewLink/);
    expect(open.nextPageToken).toBe("NEXT_1");
    expect(calls.at(-1)!.url).toContain("showCompleted=false&showHidden=false");
    const all = await (await call("/tasks/lists/L1/tasks?completed=1", { headers: h })).json() as any;
    expect(all.tasks.map((t: any) => t.id)).toEqual(["t1", "t2", "t3"]);
    expect(calls.at(-1)!.url).toContain("showCompleted=true&showHidden=true");
  });
  it("paging token and ids are validated (no injection into the Google URL)", async () => {
    const h = await tasksOnly("read");
    expect((await call("/tasks/lists/L1/tasks?pageToken=NEXT_1", { headers: h })).status).toBe(200);
    expect(calls.at(-1)!.url).toContain("pageToken=NEXT_1");
    for (const pt of ["a b", "a&showDeleted=true", "https://evil/x", "a'b", "x".repeat(1001)]) expect((await call("/tasks/lists/L1/tasks?pageToken=" + encodeURIComponent(pt), { headers: h })).status).toBe(400);
    for (const id of ["a/b", "a%2Fb", "@default", "a b", "a'b", "x".repeat(201), "a?b"]) expect([id, (await call("/tasks/lists/" + encodeURIComponent(id) + "/tasks", { headers: h })).status]).toEqual([id, 400]);
    expect(calls.filter((c) => c.url.includes("tasks.googleapis.com/tasks/v1/lists/")).every((c) => /\/lists\/L1\/tasks\?/.test(c.url))).toBe(true);
  });
  it("read-only sessions: every write is 403 and nothing reaches Google", async () => {
    const h = await tasksOnly("read");
    calls.length = 0;
    const r = await Promise.all([post("/tasks/lists/L1/tasks", { title: "x" }, h), post("/tasks/lists/L1/tasks/t1/update", { status: "completed" }, h)]);
    expect(r.map((x) => x.status)).toEqual([403, 403]);
    expect(calls).toEqual([]);
  });
  it("create: Relay builds the Google body from whitelisted fields", async () => {
    const h = await tasksOnly("write");
    calls.length = 0;
    const r = await post("/tasks/lists/L1/tasks", { title: "Buy milk", notes: "2 l", due: "2026-10-05", parent: "t1", id: "forced", status: "completed", position: "0", selfLink: "x" }, h);
    expect(r.status).toBe(400); // status is not allowed on create
    const ok = await post("/tasks/lists/L1/tasks", { title: "Buy milk", notes: "2 l", due: "2026-10-05", parent: "t1", id: "forced", selfLink: "x" }, h);
    expect(ok.status).toBe(200);
    const g = calls.find((c) => c.method === "POST")!;
    expect(g.url).toBe("https://tasks.googleapis.com/tasks/v1/lists/L1/tasks");
    expect(JSON.parse(g.body!)).toEqual({ title: "Buy milk", notes: "2 l", due: "2026-10-05T00:00:00.000Z" });
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });
  it("update: complete, reopen, edit, clear the date; bad input never reaches Google", async () => {
    const h = await tasksOnly("write");
    calls.length = 0;
    await post("/tasks/lists/L1/tasks/t1/update", { status: "completed" }, h);
    await post("/tasks/lists/L1/tasks/t1/update", { status: "needsAction" }, h);
    await post("/tasks/lists/L1/tasks/t1/update", { title: "New", notes: "", due: null }, h);
    expect(calls.filter((c) => c.method === "PATCH").map((c) => JSON.parse(c.body!))).toEqual([{ status: "completed" }, { status: "needsAction", completed: null }, { title: "New", notes: "", due: null }]);
    calls.length = 0;
    for (const b of [{}, { status: "deleted" }, { due: "2026-02-30" }, { title: "" }, { foo: "bar" }]) expect([JSON.stringify(b), (await post("/tasks/lists/L1/tasks/t1/update", b, h)).status]).toEqual([JSON.stringify(b), 400]);
    for (const id of ["a'b", "a b", "a%2F..%2Fb"]) expect((await post("/tasks/lists/L1/tasks/" + encodeURIComponent(id) + "/update", { status: "completed" }, h)).status).toBe(400);
    expect(calls).toEqual([]);
  });
  it("there is no delete: neither route nor method exists", async () => {
    const h = await tasksOnly("write");
    calls.length = 0;
    for (const [m, path] of [["DELETE", "/tasks/lists/L1/tasks/t1"], ["POST", "/tasks/lists/L1/tasks/t1/delete"], ["POST", "/tasks/lists/L1/clear"], ["DELETE", "/tasks/lists/L1"], ["POST", "/tasks/lists"]] as const)
      expect([path, (await call(path, { method: m, headers: h, body: m === "POST" ? "{}" : undefined })).status]).toEqual([path, 404]);
    expect(calls).toEqual([]);
  });
  it("write allowance: 200 changes per session, then write_limit; typos do not use it up", async () => {
    const h = await tasksOnly("write");
    for (let i = 0; i < 5; i++) await post("/tasks/lists/L1/tasks", { title: "" }, h); // rejected before the counter
    for (let i = 0; i < 200; i++) { if (i % 50 === 0) (core as any).rl.clear(); expect((await post("/tasks/lists/L1/tasks", { title: "t" + i }, h)).status).toBe(200); }
    (core as any).rl.clear();
    const over = await post("/tasks/lists/L1/tasks", { title: "one too many" }, h);
    expect([over.status, await over.json()]).toEqual([429, { error: "write_limit" }]);
  });
  it("Google errors are mapped; the token never appears in a response", async () => {
    const h = await tasksOnly("write");
    for (const [st, code] of [[403, "tasks_forbidden"], [404, "not_found"], [429, "tasks_rate_limited"], [500, "tasks_unavailable"], [400, "tasks_bad_request"]] as const) {
      googleStatus = st; (core as any).rl.clear();
      const r = await call("/tasks/lists", { headers: h });
      expect([r.status === 500 ? 502 : r.status, (await r.json() as any).error]).toEqual([st === 500 ? 502 : st, code]);
    }
    googleStatus = 200;
    const bodies = [await (await call("/tasks/lists", { headers: h })).text(), await (await call("/tasks/lists/L1/tasks", { headers: h })).text()];
    for (const b of bodies) expect(b).not.toContain(TOKEN);
  });
  it("the Tasks app describes the exact access", () => {
    expect(APPS.tasks.scopes).toEqual({ read: TASKS_R, write: TASKS_W });
    expect(APPS.tasks.describe.write).toMatch(/Cannot delete/);
  });
});
