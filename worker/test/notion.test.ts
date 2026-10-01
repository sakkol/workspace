// v4: Notion. Router-level tests with a fake Durable Object and a fake Notion.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

import worker from "../src/index";
import { StoreCore } from "../src/core";
import { FakeKV, setup, approvedTx } from "./helpers";
import { b64u, sha } from "../src/security";
import { APPS, hasAccess, makeBundle } from "../src/apps";
import { VENDORS, NOTION_VERSION, configured, creds } from "../src/vendors";
import { blockOut, pageTitle, propSummary, richText, toParagraphs, LIMITS, MAX_NOTION_WRITES } from "../src/notion";

const ORIGIN = "https://front.example", RELAY = "https://relay.example";
const TOKEN = "ntn_SECRET-NOTION-ACCESS-TOKEN", REFRESH = "nrt_SECRET-NOTION-REFRESH-TOKEN", OWNER_MAIL = "owner.person@example.com";
const P1 = "59b8df07-1111-4222-8333-444455556666", P2 = "255104cd-aaaa-4bbb-8ccc-ddddeeeeffff", B1 = "a1c2d3e4-0000-4000-8000-000000000001", CUR = "0f0f0f0f-1111-4222-8333-444455556666";

// ---------------------------------------------------------------- core / registry
describe("noScopes app (Notion)", () => {
  it("is defined by describe(), has no scope string, and skips scope verification only because of that", async () => {
    expect(APPS.notion.noScopes).toBe(true);
    expect(APPS.notion.scopes).toEqual({});
    expect(hasAccess("notion", "read")).toBe(true); expect(hasAccess("notion", "write")).toBe(true); expect(hasAccess("notion", "stream")).toBe(false);
    expect(hasAccess("gmail", "read")).toBe(true); expect(hasAccess("spotify", "read")).toBe(false); // apps WITH scopes still need a scope string
    const s = setup();
    const a = await approvedTx(s, "notion", "read", "");
    expect(a.res).toBe("ok");
    const c: any = await s.core.claim(a.id, a.secret);
    expect(c).toMatchObject({ app: "notion", access: "read", ttlMs: 30 * 60_000 });
    // Gmail still fails closed on a missing scope
    expect((await approvedTx(s, "gmail", "read", "")).res).toBe("scope");
  });
  it("can never be bundled", async () => {
    expect(makeBundle({ app: "gmail", access: "read" }, [{ app: "notion", access: "read" }])).toBeNull();
    expect(makeBundle({ app: "notion", access: "read" }, [{ app: "tasks", access: "read" }])).toBeNull();
    const s = setup(); const h = await sha("x");
    expect(await s.core.newTx("notion", "read", h, { country: "", city: "", ua: "" }, [{ app: "gmail", access: "read" }])).toEqual({ error: "bad_request" });
  });
  it("revoke is called with the session's access level (Notion has one client per level), once, at lock", async () => {
    const s = setup();
    const a = await approvedTx(s, "notion", "write", "");
    const c: any = await s.core.claim(a.id, a.secret);
    await s.core.revoke(c.cap);
    expect(s.revoked).toEqual([{ app: "notion", token: "TOKEN-notion", access: "write" }]);
  });
  it("write allowance: 20 creates/appends per session, write sessions only", async () => {
    const s = setup();
    const w: any = await s.core.claim(...(await (async () => { const a = await approvedTx(s, "notion", "write", ""); return [a.id, a.secret] as const; })()));
    for (let i = 0; i < MAX_NOTION_WRITES; i++) expect((await s.core.writeSlot(w.cap, "notion", MAX_NOTION_WRITES)).ok).toBe(true);
    expect(await s.core.writeSlot(w.cap, "notion", MAX_NOTION_WRITES)).toEqual({ ok: false, reason: "write_limit" });
    const a2 = await approvedTx(s, "notion", "read", "");
    const r: any = await s.core.claim(a2.id, a2.secret);
    expect((await s.core.writeSlot(r.cap, "notion", MAX_NOTION_WRITES)).ok).toBe(false);
  });
});

describe("vendor definition", () => {
  it("Notion: Basic auth, JSON exchange, version header, no PKCE, owner=user, revoke endpoint", () => {
    const V = VENDORS.notion;
    expect(V.authUrl).toBe("https://api.notion.com/v1/oauth/authorize"); expect(V.tokenUrl).toBe("https://api.notion.com/v1/oauth/token");
    expect(V.clientAuth).toBe("basic"); expect(V.tokenBody).toBe("json"); expect(V.pkce).toBe(false);
    expect(V.extra).toEqual({ owner: "user" }); expect(V.headers?.["Notion-Version"]).toBe(NOTION_VERSION);
    expect(V.expectsRefreshToken).toBe(true); expect(typeof V.revoke).toBe("function");
    expect(NOTION_VERSION).toBe("2026-03-11");
  });
  it("the PKCE exception is Notion-only: every other vendor still uses PKCE", () => {
    for (const v of ["google", "microsoft", "spotify"] as const) expect(VENDORS[v].pkce).not.toBe(false);
    expect(Object.entries(VENDORS).filter(([, d]) => d.pkce === false).map(([k]) => k)).toEqual(["notion"]);
  });
  it("two integrations: credentials per access level; configured() is per level and fails closed", () => {
    const env: any = { NOTION_READ_CLIENT_ID: "rid", NOTION_READ_CLIENT_SECRET: "rsec", NOTION_REDIRECT_URI: "https://r/cb" };
    expect(creds(env, "notion", "read")).toEqual({ id: "rid", secret: "rsec", redirect: "https://r/cb" });
    expect(creds(env, "notion", "write").id).toBe("");
    expect(configured(env, "notion", "read")).toBe(true);
    expect(configured(env, "notion", "write")).toBe(false); // no silent fallback to the read integration, and never the reverse
    env.NOTION_WRITE_CLIENT_ID = "wid"; env.NOTION_WRITE_CLIENT_SECRET = "wsec";
    expect(configured(env, "notion", "write")).toBe(true);
    expect(creds(env, "notion", "write").id).toBe("wid");
  });
});

// ---------------------------------------------------------------- pure helpers
describe("rendering helpers", () => {
  it("rich text keeps only plain_text (no links, mentions or annotations) and is bounded", () => {
    expect(richText([{ plain_text: "Hello ", href: "http://evil" }, { plain_text: "@Page", mention: { page: { id: "x" } } }])).toBe("Hello @Page");
    expect(richText("not an array")).toBe(""); expect(richText(null)).toBe("");
    expect(richText(Array(500).fill({ plain_text: "x".repeat(100) })).length).toBeLessThanOrEqual(LIMITS.blockText);
    expect(richText([{ plain_text: 5 }, null, {}])).toBe("");
  });
  it("page titles", () => {
    expect(pageTitle({ properties: { Name: { type: "title", title: [{ plain_text: "My\npage" }] }, X: { type: "rich_text" } } })).toBe("My page");
    expect(pageTitle({})).toBe(""); expect(pageTitle({ properties: "x" })).toBe("");
  });
  it("properties: simple types only, as text; people/relations/files are skipped", () => {
    const r = propSummary({ properties: {
      Name: { type: "title", title: [{ plain_text: "T" }] }, Status: { type: "status", status: { name: "Doing" } }, Tags: { type: "multi_select", multi_select: [{ name: "a" }, { name: "b" }] },
      Due: { type: "date", date: { start: "2026-10-01", end: null } }, Done: { type: "checkbox", checkbox: true }, Site: { type: "url", url: "http://x.y" }, N: { type: "number", number: 3 },
      Who: { type: "people", people: [{ id: "u", person: { email: "a@b.c" } }] }, Rel: { type: "relation", relation: [] }, Files: { type: "files", files: [{ file: { url: "https://s3/secret" } }] } } });
    expect(r).toEqual([{ name: "Status", value: "Doing" }, { name: "Tags", value: "a, b" }, { name: "Due", value: "2026-10-01" }, { name: "Done", value: "yes" }, { name: "Site", value: "http://x.y" }, { name: "N", value: "3" }]);
    expect(propSummary({ properties: Object.fromEntries(Array.from({ length: 80 }, (_, i) => ["p" + i, { type: "number", number: i }])) }).length).toBe(LIMITS.props);
  });
  it("blocks: text types, to-do, code, tables; media become placeholders WITHOUT their (expiring, pre-signed) URLs", () => {
    expect(blockOut({ id: B1, type: "paragraph", paragraph: { rich_text: [{ plain_text: "Hi" }] }, has_children: false })).toEqual({ id: B1, type: "paragraph", text: "Hi", hasChildren: false });
    expect(blockOut({ id: B1, type: "to_do", to_do: { rich_text: [{ plain_text: "x" }], checked: true } })).toMatchObject({ checked: true, text: "x" });
    expect(blockOut({ id: B1, type: "code", code: { rich_text: [{ plain_text: "<script>alert(1)</script>" }], language: "ja va$cript" } })).toMatchObject({ text: "<script>alert(1)</script>", language: "javacript" });
    expect(blockOut({ id: B1, type: "table_row", table_row: { cells: [[{ plain_text: "a" }], [{ plain_text: "b" }]] } }).text).toBe("a | b");
    expect(blockOut({ id: B1, type: "child_page", child_page: { title: "Sub" }, has_children: true })).toMatchObject({ text: "Sub", hasChildren: true });
    const img = blockOut({ id: B1, type: "image", image: { type: "file", file: { url: "https://prod-files-secure.s3/sig=SECRET", expiry_time: "x" }, caption: [{ plain_text: "a cat" }] } });
    expect(img.text).toBe("[image] a cat"); expect(JSON.stringify(img)).not.toMatch(/s3|SECRET|http/);
    for (const t of ["embed", "bookmark", "link_preview", "video", "pdf", "file", "audio"]) expect(blockOut({ id: B1, type: t, [t]: { url: "https://evil.example/x", caption: [] } }).text).toBe(`[${t}]`);
    expect(blockOut({ id: B1, type: "synced_block", synced_block: {} }).text).toBe("[synced block]");
    expect(blockOut({ id: B1, type: "divider" }).text).toBe("");
  });
  it("hostile blocks stay inert and bounded", () => {
    expect(blockOut({ id: "not-a-uuid", type: "paragraph!<img>", "paragraph!<img>": {} })).toMatchObject({ id: "", type: "unsupported" });
    expect(blockOut({ id: B1, type: "x".repeat(500) }).type).toBe("unsupported");
    expect(blockOut({ id: B1, type: "paragraph", paragraph: { rich_text: [{ plain_text: "A".repeat(1e6) }] } }).text).toHaveLength(LIMITS.blockText);
    expect(blockOut(null)).toMatchObject({ type: "unsupported", text: "[unsupported]" });
    expect(blockOut({ id: B1, type: "paragraph", paragraph: { rich_text: { length: 5 } } }).text).toBe("");
  });
  it("text -> paragraphs", () => {
    expect(toParagraphs("a\n\nb\nstill b\r\n\r\n\r\nc")).toEqual(["a", "b\nstill b", "c"]);
    expect(toParagraphs("  \n\n ")).toEqual([]);
    const long = toParagraphs("x".repeat(4000));
    expect(long.map((x) => x.length)).toEqual([1900, 1900, 200]);
    expect(toParagraphs("a\0b")).toEqual(["ab"]);
  });
});

// ---------------------------------------------------------------- router
let core: StoreCore, env: any, calls: Array<{ url: string; method: string; body?: string; headers: Record<string, string> }>, revoked: Array<[string, string]>, notionStatus: number;
const SEARCH = { results: [
  { object: "page", id: P1, in_trash: false, last_edited_time: "2026-09-01T10:00:00Z", url: "https://www.notion.so/SECRET", created_by: { id: "u1" }, properties: { Name: { type: "title", title: [{ plain_text: "Project plan" }] } } },
  { object: "page", id: P2, in_trash: true, properties: {} },
  { object: "data_source", id: B1, title: [] },
  { object: "page", id: "not-a-uuid", in_trash: false, properties: {} },
], has_more: true, next_cursor: CUR };
beforeEach(() => {
  calls = []; revoked = []; notionStatus = 200;
  core = new StoreCore(new FakeKV(), { seal: async (p, aad) => `sealed:${aad}:${p}`, open: async (s, aad) => s.slice(`sealed:${aad}:`.length), revoke: (app, t, access) => { revoked.push([app + "/" + access, t]); } });
  env = {
    STORE: { getByName: () => core }, FRONTEND_ORIGIN: ORIGIN, FRONTEND_URL: ORIGIN + "/workspace/", TOKEN_KEY: "x",
    GOOGLE_CLIENT_ID: "gid", GOOGLE_CLIENT_SECRET: "gsecret", GOOGLE_REDIRECT_URI: RELAY + "/oauth/google/callback",
    NOTION_READ_CLIENT_ID: "read-id", NOTION_READ_CLIENT_SECRET: "read-secret", NOTION_WRITE_CLIENT_ID: "write-id", NOTION_WRITE_CLIENT_SECRET: "write-secret", NOTION_REDIRECT_URI: RELAY + "/oauth/notion/callback",
  };
  vi.stubGlobal("fetch", async (url: any, init?: RequestInit) => {
    const u = String(url), method = init?.method ?? "GET";
    calls.push({ url: u, method, body: init?.body === undefined ? undefined : String(init.body), headers: (init?.headers ?? {}) as Record<string, string> });
    if (u === "https://api.notion.com/v1/oauth/token")
      return Response.json({ access_token: TOKEN, refresh_token: REFRESH, token_type: "bearer", bot_id: "b", workspace_id: "w", workspace_name: "Secret WS", owner: { type: "user", user: { name: "Owner Name", person: { email: OWNER_MAIL } } } });
    if (u === "https://oauth2.googleapis.com/token") return Response.json({ access_token: "ya29.G", expires_in: 3599, scope: "https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/tasks" });
    if (!u.startsWith("https://api.notion.com/v1/")) return new Response("{}", { status: 404 });
    if (notionStatus !== 200) return new Response("{}", { status: notionStatus, headers: notionStatus === 429 ? { "Retry-After": "11" } : {} });
    if (u.endsWith("/v1/search")) return Response.json(SEARCH);
    if (method === "GET" && /\/v1\/pages\/[\w-]+$/.test(u)) return Response.json({ object: "page", id: P1, properties: { Name: { type: "title", title: [{ plain_text: "Project plan" }] }, Status: { type: "status", status: { name: "Doing" } } } });
    if (method === "GET" && u.includes("/children")) return Response.json({ results: [
      { id: B1, type: "heading_1", heading_1: { rich_text: [{ plain_text: "Goals" }] } },
      { id: P2, type: "paragraph", paragraph: { rich_text: [{ plain_text: "<img src=x onerror=alert(1)> see " }, { plain_text: "link", href: "http://evil.example" }] }, has_children: true },
      { id: CUR, type: "image", image: { file: { url: "https://s3.amazonaws.com/SIGNED" } } },
    ], has_more: u.includes("start_cursor") ? false : true, next_cursor: CUR });
    if (method === "POST" && u.endsWith("/v1/pages")) return Response.json({ object: "page", id: P2, url: "https://www.notion.so/SECRET", created_by: { id: "u" } });
    if (method === "PATCH" && u.endsWith("/children")) return Response.json({ results: [] });
    if (u.endsWith("/v1/oauth/revoke")) return Response.json({});
    return new Response("{}", { status: 404 });
  });
});
afterEach(() => {
  expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  // nothing that edits, moves or trashes an existing page, and no account information is requested (R14, R26)
  expect(calls.some((c) => c.method === "PATCH" && !c.url.endsWith("/children"))).toBe(false);
  expect(calls.some((c) => /\/users(\/|\?|$)/.test(c.url))).toBe(false);
});

const call = (path: string, init: RequestInit & { origin?: string | null } = {}) => {
  const headers = new Headers(init.headers);
  if (init.origin !== null) headers.set("Origin", init.origin ?? ORIGIN);
  return worker.fetch(new Request(RELAY + path, { ...init, headers }), env);
};
const post = (path: string, body?: unknown, headers: Record<string, string> = {}) => call(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body), headers });
const bearer = (cap: string) => ({ Authorization: "Bearer " + cap });

async function unlock(app: string, access: string, also?: unknown) {
  const secret = b64u(crypto.getRandomValues(new Uint8Array(32)));
  const startRes = await post("/link/start", { app, access, also, claimHash: await sha(secret) });
  const start = await startRes.json() as any;
  if (startRes.status !== 200) return { startRes, start } as any;
  const info = await (await call("/link/info/" + start.id)).json() as any;
  const conf = await (await post("/link/confirm/" + start.id, { code: start.code })).json() as any;
  const vendor = app === "notion" ? "notion" : "google";
  const auth = await call(`/oauth/${vendor}?tx=${start.id}&n=${conf.nonce}`, { origin: null });
  const authUrl = new URL(auth.headers.get("Location")!);
  const cb = await call(`/oauth/${vendor}/callback?code=abc&state=${encodeURIComponent(authUrl.searchParams.get("state")!)}`, { origin: null });
  const claim = () => post("/link/claim/" + start.id, undefined, { "X-Claim-Secret": secret });
  return { startRes, start, info, authUrl, cb, claim };
}
const rd = async () => bearer(((await (await (await unlock("notion", "read")).claim()).json()) as any).cap);
const wr = async () => bearer(((await (await (await unlock("notion", "write")).claim()).json()) as any).cap);

describe("unlock", () => {
  it("authorize URL: owner=user, state, exact redirect, NO scope, NO PKCE / offline / include_granted_scopes; the READ integration for read", async () => {
    const u = await unlock("notion", "read");
    expect(u.info.describe).toMatch(/Nothing can be changed/);
    expect(u.authUrl.origin + u.authUrl.pathname).toBe("https://api.notion.com/v1/oauth/authorize");
    const q = u.authUrl.searchParams;
    expect(q.get("client_id")).toBe("read-id"); expect(q.get("owner")).toBe("user"); expect(q.get("response_type")).toBe("code");
    expect(q.get("redirect_uri")).toBe(RELAY + "/oauth/notion/callback"); expect(q.get("state")).toMatch(/\./);
    for (const bad of ["scope", "code_challenge", "code_challenge_method", "include_granted_scopes", "access_type", "client_secret", "prompt"]) expect(q.has(bad)).toBe(false);
    expect(u.authUrl.toString()).not.toMatch(/secret|offline/i);
    expect(u.cb.headers.get("Location")).toContain("/done");
  });
  it("the WRITE integration is used for write (authorize, token exchange with Basic auth + JSON, revoke)", async () => {
    const u = await unlock("notion", "write");
    expect(u.authUrl.searchParams.get("client_id")).toBe("write-id");
    const ex = calls.find((c) => c.url === "https://api.notion.com/v1/oauth/token")!;
    expect(ex.headers.Authorization).toBe("Basic " + btoa("write-id:write-secret"));
    expect(ex.headers["Content-Type"]).toBe("application/json"); expect(ex.headers["Notion-Version"]).toBe("2026-03-11");
    expect(JSON.parse(ex.body!)).toEqual({ grant_type: "authorization_code", code: "abc", redirect_uri: RELAY + "/oauth/notion/callback" }); // no code_verifier, no client_secret in the body
    const rx = calls.find((c) => c.url === "https://api.notion.com/v1/oauth/token")!; expect(rx.body).not.toMatch(/secret|verifier/);
    const r = await unlock("notion", "read");
    expect(calls.filter((c) => c.url.endsWith("/oauth/token")).at(-1)!.headers.Authorization).toBe("Basic " + btoa("read-id:read-secret"));
    expect(r.startRes.status).toBe(200);
  });
  it("refresh token, owner name/e-mail and workspace info are discarded: in no response, no log, no storage", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const u = await unlock("notion", "read");
    const claimed = await (await u.claim()).json() as any;
    const cap = claimed.cap;
    const r = await post("/notion/search", {}, bearer(cap));
    const all = JSON.stringify(claimed) + (await r.text()) + u.cb.headers.get("Location") + JSON.stringify(log.mock.calls);
    for (const secret of [TOKEN, REFRESH, OWNER_MAIL, "Owner Name", "Secret WS"]) expect(all).not.toContain(secret);
    expect(log).not.toHaveBeenCalled(); // Notion is known to return a refresh token: expected, so not even an event is logged
    log.mockRestore();
    const stored = JSON.stringify([...(core as any).kv.m.values()]);
    for (const secret of [REFRESH, OWNER_MAIL, "Owner Name", "Secret WS"]) expect(stored).not.toContain(secret);
  });
  it("read-only and write levels are configured independently; missing integration = app_not_configured (fail closed)", async () => {
    delete env.NOTION_WRITE_CLIENT_SECRET;
    expect((await unlock("notion", "write")).startRes.status).toBe(503);
    expect((await unlock("notion", "read")).startRes.status).toBe(200);
    const h = await (await call("/health", { origin: null })).json() as any;
    expect(h.configured).toMatchObject({ notion: true, notionWrite: false });
    delete env.NOTION_READ_CLIENT_ID;
    expect((await unlock("notion", "read")).startRes.status).toBe(503);
    expect(JSON.stringify(await (await call("/health", { origin: null })).json())).not.toMatch(/read-secret|write-id/);
  });
  it("bundles with Notion are refused", async () => {
    expect((await unlock("gmail", "read", [{ app: "notion", access: "read" }])).startRes.status).toBe(400);
    expect((await unlock("notion", "read", [{ app: "tasks", access: "read" }])).startRes.status).toBe(400);
  });
  it("Lock revokes the token at Notion with the right integration's credentials", async () => {
    await (VENDORS.notion.revoke!("tok-1", { env, access: "write" }));
    await (VENDORS.notion.revoke!("tok-2", { env, access: "read" }));
    const rv = calls.filter((c) => c.url === "https://api.notion.com/v1/oauth/revoke");
    expect(rv.map((c) => [c.headers.Authorization, JSON.parse(c.body!)])).toEqual([
      ["Basic " + btoa("write-id:write-secret"), { token: "tok-1" }], ["Basic " + btoa("read-id:read-secret"), { token: "tok-2" }],
    ]);
    expect(rv.every((c) => c.headers["Notion-Version"] === "2026-03-11" && c.headers["Content-Type"] === "application/json")).toBe(true);
    const u = await unlock("notion", "read"); const cap = ((await (await u.claim()).json()) as any).cap;
    await post("/session/revoke", undefined, bearer(cap));
    expect(revoked).toEqual([["notion/read", TOKEN]]);
    expect((await call("/notion/search", { method: "POST", headers: bearer(cap) })).status).toBe(401);
  });
});

describe("capability binding", () => {
  it("a Notion capability works nowhere else, and nothing else works on Notion", async () => {
    const n = await rd();
    const g = await unlock("gmail", "write", [{ app: "tasks", access: "write" }]); const gc = await (await g.claim()).json() as any;
    for (const path of ["/gmail/profile", "/tasks/lists", "/outlook/profile", "/spotify/player"]) expect((await call(path, { headers: n })).status).toBe(401);
    for (const cap of [gc.caps.gmail.cap, gc.caps.tasks.cap]) expect((await post("/notion/search", {}, bearer(cap))).status).toBe(401);
    expect((await post("/notion/search", {}, n)).status).toBe(200);
    expect((await post("/notion/search", {})).status).toBe(401);
    expect((await call("/notion/search", { method: "POST", origin: "https://evil.example", headers: n })).status).toBe(403);
  });
});

describe("reading", () => {
  it("search: Relay-built body, trash / non-pages / bad ids dropped, nothing but id+title+date returned", async () => {
    const h = await rd();
    const r = await post("/notion/search", { query: "  plan ", cursor: CUR, filter: { value: "data_source" }, page_size: 1000, sort: "x" }, h);
    const j = await r.json() as any;
    expect(j).toEqual({ results: [{ id: P1, title: "Project plan", edited: "2026-09-01T10:00:00Z" }], next: CUR });
    expect(JSON.stringify(j)).not.toMatch(/SECRET|notion\.so|created_by/);
    const n = calls.find((c) => c.url.endsWith("/v1/search"))!;
    expect(JSON.parse(n.body!)).toEqual({ query: "plan", filter: { property: "object", value: "page" }, sort: { timestamp: "last_edited_time", direction: "descending" }, page_size: 20, start_cursor: CUR });
    expect(n.headers.Authorization).toBe("Bearer " + TOKEN); expect(n.headers["Notion-Version"]).toBe("2026-03-11");
  });
  it("search: empty query, and validation of query and cursor", async () => {
    const h = await rd();
    await post("/notion/search", {}, h);
    expect(JSON.parse(calls.find((c) => c.url.endsWith("/v1/search"))!.body!)).not.toHaveProperty("query");
    for (const b of [{ query: 5 }, { query: "x".repeat(201) }, { cursor: "abc" }, { cursor: 5 }, { cursor: CUR + "'" }, { cursor: CUR.toUpperCase() }]) expect([JSON.stringify(b), (await post("/notion/search", b, h)).status]).toEqual([JSON.stringify(b), 400]);
  });
  it("page: title, properties (first page only), blocks as inert text, no links, no file URLs", async () => {
    const h = await rd();
    const j = await (await call(`/notion/pages/${P1}`, { headers: h })).json() as any;
    expect(j.title).toBe("Project plan"); expect(j.props).toEqual([{ name: "Status", value: "Doing" }]);
    expect(j.blocks.map((b: any) => [b.type, b.text, b.hasChildren])).toEqual([["heading_1", "Goals", false], ["paragraph", "<img src=x onerror=alert(1)> see link", true], ["image", "[image]", false]]);
    expect(JSON.stringify(j)).not.toMatch(/evil\.example|amazonaws|SIGNED/);
    expect(j.next).toBe(CUR);
    calls.length = 0;
    const j2 = await (await call(`/notion/pages/${P1}?cursor=${CUR}`, { headers: h })).json() as any;
    expect(j2.title).toBeUndefined(); expect(j2.next).toBeNull();
    expect(calls.some((c) => /\/v1\/pages\//.test(c.url))).toBe(false); // the page itself is fetched once
    expect(calls.find((c) => c.url.includes("/children"))!.url).toBe(`https://api.notion.com/v1/blocks/${P1}/children?page_size=100&start_cursor=${CUR}`);
  });
  it("blocks/:id/children expands nested content", async () => {
    const h = await rd();
    const j = await (await call(`/notion/blocks/${P2}/children`, { headers: h })).json() as any;
    expect(j.blocks).toHaveLength(3);
    expect(calls.at(-1)!.url).toBe(`https://api.notion.com/v1/blocks/${P2}/children?page_size=100`);
  });
  it("ids are strict UUIDs; nothing else reaches the Notion URL", async () => {
    const h = await rd();
    calls.length = 0;
    const bad = ["x", "..", "59b8df0711114222833344445555666", P1.toUpperCase(), P1.replace(/-/g, ""), `{${P1}}`, P1 + "x", P1 + "/children", "a'b", "%2e%2e", P1 + "%2F..", "me", "@default", P1 + "?a=b", " " + P1];
    for (const id of bad) for (const path of ["/notion/pages/", "/notion/blocks/"]) {
      const url = path + encodeURIComponent(id) + (path.includes("blocks") ? "/children" : "");
      const r = await call(url, { headers: h });
      expect([id, path, r.status === 404 && id === ".." ? 400 : r.status]).toEqual([id, path, 400]);
    }
    for (const cur of ["x", "../x", CUR + "&page_size=1", "1 2", CUR.toUpperCase()]) expect((await call(`/notion/pages/${P1}?cursor=${encodeURIComponent(cur)}`, { headers: h })).status).toBe(400);
    expect(calls).toEqual([]);
  });
});

describe("writing", () => {
  it("a read session cannot reach ANY write route (Relay side), and nothing is sent to Notion", async () => {
    const h = await rd();
    calls.length = 0;
    const r = await Promise.all([post("/notion/pages", { parentId: P1, title: "t" }, h), post(`/notion/blocks/${P1}/append`, { text: "x" }, h)]);
    expect(r.map((x) => x.status)).toEqual([403, 403]);
    expect(calls).toEqual([]);
  });
  it("create page: Relay builds the Notion body (page parent, plain-text paragraphs, title)", async () => {
    const h = await wr();
    calls.length = 0;
    const r = await post("/notion/pages", { parentId: P1, title: " Meeting\nnotes ", text: "First.\n\nSecond <b>bold</b>.", icon: "x", cover: { external: { url: "http://evil" } }, properties: { Status: "x" }, parent: { database_id: "y" }, archived: true }, h);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ id: P2, title: "Meeting notes" }); // no URL, no author
    const n = calls.find((c) => c.method === "POST" && c.url.endsWith("/v1/pages"))!;
    expect(JSON.parse(n.body!)).toEqual({
      parent: { page_id: P1 }, properties: { title: { title: [{ type: "text", text: { content: "Meeting notes" } }] } },
      children: [{ object: "block", type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content: "First." } }] } }, { object: "block", type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content: "Second <b>bold</b>." } }] } }],
    });
  });
  it("create page: title only is fine; validation of parent, title, text, block count", async () => {
    const h = await wr();
    expect((await post("/notion/pages", { parentId: P1, title: "Empty" }, h)).status).toBe(200);
    expect(JSON.parse(calls.find((c) => c.url.endsWith("/v1/pages"))!.body!)).not.toHaveProperty("children");
    calls.length = 0;
    const bad: any[] = [{ title: "t" }, { parentId: "x", title: "t" }, { parentId: P1.toUpperCase(), title: "t" }, { parentId: P1 }, { parentId: P1, title: "" }, { parentId: P1, title: "  " }, { parentId: P1, title: 5 },
      { parentId: P1, title: "t".repeat(301) }, { parentId: P1, title: "t", text: 5 }, { parentId: P1, title: "t", text: "x".repeat(20_001) },
      { parentId: P1, title: "t", text: Array(101).fill("p").join("\n\n") }, { parentId: { page_id: P1 }, title: "t" }];
    for (const b of bad) { (core as any).rl.clear(); expect([JSON.stringify(b).slice(0, 60), (await post("/notion/pages", b, h)).status]).toEqual([JSON.stringify(b).slice(0, 60), 400]); }
    expect(calls).toEqual([]);
  });
  it("append: paragraphs only, at the end; nothing else can be touched", async () => {
    const h = await wr();
    calls.length = 0;
    const r = await post(`/notion/blocks/${P1}/append`, { text: "Line one\n\nLine two", position: { type: "start" }, after: B1, children: [{ type: "embed" }] }, h);
    expect(await r.json()).toEqual({ ok: true, added: 2 });
    const n = calls.find((c) => c.method === "PATCH")!;
    expect(n.url).toBe(`https://api.notion.com/v1/blocks/${P1}/children`);
    expect(JSON.parse(n.body!)).toEqual({ children: [
      { object: "block", type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content: "Line one" } }] } },
      { object: "block", type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content: "Line two" } }] } }] });
    (core as any).rl.clear();
    for (const [id, b] of [["x", { text: "a" }], [P1, { text: "" }], [P1, { text: "   " }], [P1, {}], [P1, { text: 5 }], [P1, { text: "x".repeat(20_001) }], [P1, { text: Array(101).fill("p").join("\n\n") }]] as const) {
      (core as any).rl.clear(); expect([String(id), JSON.stringify(b).slice(0, 40), (await post(`/notion/blocks/${id}/append`, b, h)).status]).toEqual([String(id), JSON.stringify(b).slice(0, 40), 400]);
    }
  });
  it("there is no edit, delete, archive, move, comment or users route; no DELETE/PATCH-page ever", async () => {
    const h = await wr();
    calls.length = 0;
    for (const [m, path] of [["DELETE", `/notion/blocks/${B1}`], ["POST", `/notion/blocks/${B1}/delete`], ["POST", `/notion/pages/${P1}`], ["PATCH", `/notion/pages/${P1}`], ["POST", `/notion/pages/${P1}/archive`], ["POST", `/notion/pages/${P1}/move`],
      ["POST", `/notion/blocks/${B1}/update`], ["POST", "/notion/comments"], ["GET", "/notion/users"], ["POST", "/notion/databases/query"]] as const)
      expect([path, (await call(path, { method: m, headers: h, body: m === "POST" ? "{}" : undefined })).status]).toEqual([path, 404]);
    expect(calls).toEqual([]);
  });
  it("20 writes per session, then write_limit; typos do not use it up", async () => {
    const h = await wr();
    for (let i = 0; i < 5; i++) await post(`/notion/blocks/${P1}/append`, { text: "" }, h);
    for (let i = 0; i < MAX_NOTION_WRITES; i++) { (core as any).rl.clear(); expect((await post(`/notion/blocks/${P1}/append`, { text: "t" + i }, h)).status).toBe(200); }
    (core as any).rl.clear();
    const over = await post("/notion/pages", { parentId: P1, title: "too many" }, h);
    expect([over.status, await over.json()]).toEqual([429, { error: "write_limit" }]);
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(MAX_NOTION_WRITES);
  });
  it("per-minute write limit", async () => {
    const h = await wr(); const s: number[] = [];
    for (let i = 0; i < 11; i++) s.push((await post(`/notion/blocks/${P1}/append`, { text: "x" }, h)).status);
    expect(s.slice(0, 10).every((x) => x === 200)).toBe(true); expect(s[10]).toBe(429);
  });
});

describe("Notion errors", () => {
  it("mapped; Retry-After passed; a 401 ends the session; the token is in no response", async () => {
    const u = await unlock("notion", "read"); const h = bearer(((await (await u.claim()).json()) as any).cap);
    for (const [st, code] of [[403, "notion_forbidden"], [404, "not_found"], [429, "notion_rate_limited"], [529, "notion_rate_limited"], [500, "notion_unavailable"], [409, "notion_unavailable"], [400, "notion_bad_request"]] as const) {
      notionStatus = st; (core as any).rl.clear();
      const r = await post("/notion/search", {}, h);
      const body = await r.text();
      expect([st, r.status, JSON.parse(body).error]).toEqual([st, st === 529 ? 429 : st >= 500 || st === 409 ? 502 : st, code]);
      expect(body).not.toContain(TOKEN);
      if (st === 429) expect(r.headers.get("Retry-After")).toBe("11");
    }
    notionStatus = 401;
    expect((await post("/notion/search", {}, h)).status).toBe(401);
    notionStatus = 200;
    expect((await post("/notion/search", {}, h)).status).toBe(401); // session removed
    expect(revoked).toHaveLength(1);
  });
});
