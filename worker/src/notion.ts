// Notion (v4). Same rules as gmail.ts: route allow-list, strict ID patterns, the Relay builds every Notion request from
// structured fields, nothing Notion returns is trusted (R12, R13).
//
// What exists: search (pages and databases), read a page (as plain text), create a page under a page, append plain paragraphs to a page,
// browse database rows (data sources), create a row and edit a row's SIMPLE properties (v4.1).
// What does NOT exist (R14): editing or deleting page text/blocks, trashing/archiving, moving, comments, files, schema changes, users.
// Every property write is built by the Relay from the REAL column schema fetched from Notion (the browser only names columns and gives values).
// The Notion token is never sent anywhere except api.notion.com; `/users/me` is never called (R26).
import type { RouteCtx } from "./ctx";
import { HttpErr, Bad } from "./errors";
import { NOTION_VERSION } from "./vendors";

const API = "https://api.notion.com/v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/; // Notion returns lower-case dashed ids
export const LIMITS = { query: 200, title: 300, text: 20_000, chunk: 1900, blocks: 100, blockText: 4000, props: 25, pageSize: 100 };
export const MAX_NOTION_WRITES = 50; // page creates, appends, row creates and row edits per session

type Method = "GET" | "POST" | "PATCH"; // DELETE is deliberately not representable
async function notion(token: string, path: string, init?: { method?: Method; body?: unknown }) {
  const method = init?.method ?? "GET";
  if ((method as string) === "DELETE") throw new Error("delete_not_allowed");
  const r = await fetch(API + path, {
    method,
    headers: { Authorization: "Bearer " + token, "Notion-Version": NOTION_VERSION, ...(init?.body ? { "Content-Type": "application/json" } : {}) },
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
  if (r.status === 401) throw new HttpErr(401, "session_expired");
  if (r.status === 403) throw new HttpErr(403, "notion_forbidden"); // restricted_resource: the page is not shared, or the integration lacks the capability
  if (r.status === 404) throw new HttpErr(404, "not_found"); // also what Notion says for pages that were not shared with the integration
  if (r.status === 400) throw new HttpErr(400, "notion_bad_request");
  if (r.status === 429 || r.status === 529) throw new HttpErr(429, "notion_rate_limited", r.headers.get("Retry-After"));
  if (!r.ok) throw new HttpErr(502, "notion_unavailable");
  return (await r.json()) as any;
}

const str = (x: unknown, max: number) => (typeof x === "string" ? x.slice(0, max) : "");
const oneLine = (s: string) => s.replace(/[\r\n\0\t]+/g, " ").trim();

/** Rich text -> plain text. Annotations, links and mention targets are dropped on purpose (R12): only `plain_text`. */
export function richText(arr: unknown, max = LIMITS.blockText): string {
  if (!Array.isArray(arr)) return "";
  let out = "";
  for (const t of arr.slice(0, 100)) { out += str(t?.plain_text, max); if (out.length >= max) break; }
  return out.slice(0, max);
}

export function pageTitle(page: any): string {
  const props = page?.properties;
  if (!props || typeof props !== "object") return "";
  for (const v of Object.values<any>(props)) if (v?.type === "title") return oneLine(richText(v.title, LIMITS.title));
  return "";
}

/** A few simple property types of a database row, as text. Everything else (people, relations, files, rollups) is skipped. */
export function propSummary(page: any): Array<{ name: string; value: string }> {
  const out: Array<{ name: string; value: string }> = [];
  for (const [name, v] of Object.entries<any>(page?.properties && typeof page.properties === "object" ? page.properties : {})) {
    if (out.length >= LIMITS.props) break;
    let val = "";
    switch (v?.type) {
      case "rich_text": val = richText(v.rich_text, 300); break;
      case "number": val = typeof v.number === "number" ? String(v.number) : ""; break;
      case "select": case "status": val = str(v[v.type]?.name, 100); break;
      case "multi_select": val = Array.isArray(v.multi_select) ? v.multi_select.slice(0, 20).map((o: any) => str(o?.name, 60)).join(", ") : ""; break;
      case "date": val = v.date ? [str(v.date.start, 40), str(v.date.end, 40)].filter(Boolean).join(" → ") : ""; break;
      case "checkbox": val = v.checkbox === true ? "yes" : "no"; break;
      case "url": case "email": case "phone_number": val = str(v[v.type], 300); break; // shown as text, never as a link
      case "created_time": case "last_edited_time": val = str(v[v.type], 40); break;
      default: continue;
    }
    if (val) out.push({ name: oneLine(str(name, 80)), value: oneLine(val) });
  }
  return out;
}

const TEXT_BLOCKS = new Set(["paragraph", "heading_1", "heading_2", "heading_3", "heading_4", "bulleted_list_item", "numbered_list_item", "to_do", "toggle", "quote", "callout", "code"]);
const MEDIA = new Set(["image", "file", "pdf", "video", "audio", "embed", "bookmark", "link_preview"]);
const TYPE = /^[a-z0-9_]{1,40}$/;

/**
 * One Notion block -> `{id, type, text, hasChildren}`. File, image, embed and bookmark URLs are NEVER surfaced (Notion file URLs are
 * pre-signed and expiring); only a placeholder and the caption. Blocks are not expanded here: `hasChildren` lets the UI ask for them.
 */
export function blockOut(b: any) {
  const type = TYPE.test(str(b?.type, 41)) ? b.type : "unsupported";
  const d = b?.[type];
  let text = "";
  if (TEXT_BLOCKS.has(type)) text = richText(d?.rich_text);
  else if (type === "child_page" || type === "child_database") text = oneLine(str(d?.title, LIMITS.title));
  else if (type === "equation") text = str(d?.expression, 1000);
  else if (type === "table_row") text = Array.isArray(d?.cells) ? d.cells.slice(0, 20).map((c: any) => oneLine(richText(c, 300))).join(" | ") : "";
  else if (MEDIA.has(type)) { const cap = richText(d?.caption, 500); text = `[${type}]` + (cap ? " " + cap : ""); }
  else if (type !== "divider") text = `[${type.replace(/_/g, " ")}]`;
  const out: { id: string; type: string; text: string; hasChildren: boolean; checked?: boolean; language?: string } = {
    id: UUID.test(str(b?.id, 40)) ? b.id : "", type, text, hasChildren: b?.has_children === true,
  };
  if (type === "to_do") out.checked = d?.checked === true;
  if (type === "code") out.language = str(d?.language, 30).replace(/[^\w+#.-]/g, "");
  return out;
}

/** Column types the UI can edit. Everything else (formula, relation, people, files, rollup, ...) is shown as read-only or not at all. */
const EDITABLE = new Set(["title", "rich_text", "number", "select", "multi_select", "status", "date", "checkbox", "url", "email", "phone_number"]);
export interface Col { name: string; type: string; editable: boolean; options?: string[] }
const TYPE_OK = /^[a-z_]{1,30}$/;

/** A data source's columns, from Notion's schema. Names are untrusted text (<=100 chars); option lists are bounded. */
export function schemaOut(ds: any): Col[] {
  const props = ds?.properties && typeof ds.properties === "object" ? ds.properties : {};
  const out: Col[] = [];
  for (const [key, d] of Object.entries<any>(props)) {
    if (out.length >= 50) break;
    const type = TYPE_OK.test(str(d?.type, 31)) ? d.type : "unsupported";
    const col: Col = { name: oneLine(str(d?.name ?? key, 100)), type, editable: EDITABLE.has(type) };
    if (!col.name) continue;
    if (type === "select" || type === "multi_select" || type === "status") {
      const opts = d?.[type]?.options;
      col.options = Array.isArray(opts) ? opts.slice(0, 100).map((o: any) => oneLine(str(o?.name, 100))).filter(Boolean) : [];
    }
    out.push(col);
  }
  return out;
}

const text1 = (content: string) => [{ type: "text", text: { content } }];
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
export function validDate(v: unknown): v is string {
  if (typeof v !== "string") return false;
  const m = DATE.exec(v); if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] && +m[1] >= 1000 && +m[1] <= 9999;
}

/** One browser value -> a Notion property value, by the column's REAL type. Anything unexpected is a 400; nothing is coerced. */
export function propertyValue(col: Col, v: unknown): unknown {
  const bad = () => new Bad("bad_value");
  switch (col.type) {
    case "title": { if (typeof v !== "string") throw bad(); const t = oneLine(v); if (!t || t.length > LIMITS.title) throw new Bad("bad_title"); return { title: text1(t) }; }
    case "rich_text": { if (v === null) return { rich_text: [] }; if (typeof v !== "string" || v.length > 2000) throw bad(); const t = v.replace(/\0/g, ""); return { rich_text: t ? text1(t) : [] }; }
    case "number": { if (v === null || v === "") return { number: null }; if (typeof v !== "number" || !Number.isFinite(v) || Math.abs(v) > 1e15) throw bad(); return { number: v }; }
    case "checkbox": { if (typeof v !== "boolean") throw bad(); return { checkbox: v }; }
    case "date": { if (v === null || v === "") return { date: null }; if (!validDate(v)) throw new Bad("bad_due"); return { date: { start: v } }; }
    case "url": { if (v === null || v === "") return { url: null }; if (typeof v !== "string" || v.length > 2000 || !/^https?:\/\/[^\s<>"']+$/i.test(v)) throw bad(); return { url: v }; }
    case "email": { if (v === null || v === "") return { email: null }; if (typeof v !== "string" || v.length > 254 || !/^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/.test(v)) throw bad(); return { email: v }; }
    case "phone_number": { if (v === null || v === "") return { phone_number: null }; if (typeof v !== "string" || !/^[0-9+()\-. ]{3,40}$/.test(v)) throw bad(); return { phone_number: v }; }
    case "select": case "status": {
      if (v === null || v === "") { if (col.type === "status") throw bad(); return { select: null }; }
      if (typeof v !== "string" || !col.options?.includes(v)) throw new Bad("unknown_option"); // never creates a new option
      return { [col.type]: { name: v } };
    }
    case "multi_select": {
      if (!Array.isArray(v) || v.length > 20 || v.some((x) => typeof x !== "string" || !col.options?.includes(x))) throw new Bad("unknown_option");
      return { multi_select: [...new Set(v as string[])].map((name) => ({ name })) };
    }
    default: throw new Bad("property_not_editable");
  }
}

/** The `properties` object of a create/update request, built from the schema (not from the browser's idea of it). */
export function buildProperties(cols: Col[], values: unknown, creating: boolean): Record<string, unknown> {
  if (!values || typeof values !== "object" || Array.isArray(values)) throw new Bad("bad_values");
  const keys = Object.keys(values);
  if (!keys.length || keys.length > 30) throw new Bad("bad_values");
  const byName = new Map(cols.map((c) => [c.name, c]));
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    const col = byName.get(k);
    if (!col) throw new Bad("unknown_property");
    if (!col.editable) throw new Bad("property_not_editable");
    out[col.name] = propertyValue(col, (values as Record<string, unknown>)[k]);
  }
  if (creating) { const t = cols.find((c) => c.type === "title"); if (!t || !(t.name in out)) throw new Bad("bad_title"); }
  return out;
}

/** Current values of a row's editable columns, as plain values for the edit form. */
export function rowValues(page: any, cols: Col[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const props = page?.properties && typeof page.properties === "object" ? page.properties : {};
  for (const c of cols) {
    if (!c.editable) continue;
    const v = props[c.name];
    switch (c.type) {
      case "title": out[c.name] = oneLine(richText(v?.title, LIMITS.title)); break;
      case "rich_text": out[c.name] = richText(v?.rich_text, 2000); break;
      case "number": out[c.name] = typeof v?.number === "number" ? v.number : null; break;
      case "checkbox": out[c.name] = v?.checkbox === true; break;
      case "date": out[c.name] = str(v?.date?.start, 40).slice(0, 10); break;
      case "select": case "status": out[c.name] = str(v?.[c.type]?.name, 100); break;
      case "multi_select": out[c.name] = Array.isArray(v?.multi_select) ? v.multi_select.slice(0, 20).map((o: any) => str(o?.name, 100)) : []; break;
      default: out[c.name] = str(v?.[c.type], 2000);
    }
  }
  return out;
}

const rowOut = (pg: any) => ({ id: UUID.test(str(pg?.id, 40)) ? pg.id : "", title: pageTitle(pg), edited: str(pg?.last_edited_time, 40), cells: propSummary(pg).slice(0, 6) });
const isRow = (pg: any) => pg?.parent?.type === "data_source_id" || pg?.parent?.type === "database_id";

const cursorOk = (c: string | null) => { if (c && !UUID.test(c)) throw new Bad("bad_cursor"); return c || ""; };

/** Plain text -> paragraph blocks (blank line = new paragraph; long paragraphs are cut at 1900 chars; Notion's limit is 2000). */
export function toParagraphs(text: string): string[] {
  const parts = text.replace(/\r\n?/g, "\n").replace(/\0/g, "").split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const out: string[] = [];
  for (const p of parts) for (let i = 0; i < p.length; i += LIMITS.chunk) out.push(p.slice(i, i + LIMITS.chunk));
  return out;
}
const paraBlocks = (ps: string[]) => ps.map((content) => ({ object: "block", type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content } }] } }));

export async function handleNotion(c: RouteCtx): Promise<Response> {
  const { p, req, u, J, store, bearer } = c;
  if (!(await c.lim("notion", 120))) return J({ error: "rate_limited" }, 429);
  const s = bearer ? await store.auth(bearer, "notion") : null;
  if (!s) return J({ error: "session_expired" }, 401);
  const token = s.token;
  const needWrite = () => { if (s.access !== "write") throw new HttpErr(403, "read_only"); };
  // Spent only after validation, so a typo cannot use up the session's allowance (R14).
  const spend = async () => {
    if (!(await c.lim("notion-write", 10))) throw new HttpErr(429, "rate_limited");
    const slot = await store.writeSlot(bearer!, "notion", MAX_NOTION_WRITES);
    if (!slot.ok) throw new HttpErr(slot.reason === "write_limit" ? 429 : 401, slot.reason);
  };
  let m: RegExpMatchArray | null;

  if (p === "/notion/search" && req.method === "POST") {
    const b = await c.json();
    const query = b.query === undefined ? "" : typeof b.query === "string" ? b.query.trim() : null;
    if (query === null || query.length > LIMITS.query) throw new Bad("bad_query");
    const cur = b.cursor === undefined || b.cursor === null || b.cursor === "" ? "" : typeof b.cursor === "string" ? cursorOk(b.cursor) : (() => { throw new Bad("bad_cursor"); })();
    const kind = b.kind === undefined ? "pages" : b.kind;
    if (kind !== "pages" && kind !== "databases") throw new Bad("bad_query");
    const r = await notion(token, "/search", {
      method: "POST",
      body: { ...(query ? { query } : {}), filter: { property: "object", value: kind === "databases" ? "data_source" : "page" }, sort: { timestamp: "last_edited_time", direction: "descending" }, page_size: 20, ...(cur ? { start_cursor: cur } : {}) },
    });
    const want = kind === "databases" ? "data_source" : "page";
    const results = (Array.isArray(r.results) ? r.results : []).filter((x: any) => x?.object === want && x.in_trash !== true && UUID.test(str(x.id, 40)))
      .map((x: any) => ({ id: x.id as string, title: want === "page" ? pageTitle(x) : oneLine(richText(x.title, LIMITS.title)), edited: str(x.last_edited_time, 40) }));
    return J({ results, next: r.has_more === true && UUID.test(str(r.next_cursor, 40)) ? r.next_cursor : null });
  }

  // A page: its title, a few simple properties (first page of results only) and its blocks as plain text.
  if ((m = p.match(/^\/notion\/pages\/([^/]+)$/)) && req.method === "GET") {
    if (!UUID.test(m[1])) throw new Bad("bad_id");
    const cur = cursorOk(u.searchParams.get("cursor"));
    const qs = `?page_size=${LIMITS.pageSize}` + (cur ? `&start_cursor=${cur}` : "");
    const [page, kids] = await Promise.all([cur ? Promise.resolve(null) : notion(token, `/pages/${m[1]}`), notion(token, `/blocks/${m[1]}/children${qs}`)]);
    return J({
      id: m[1], ...(page ? { title: pageTitle(page), props: propSummary(page), isRow: isRow(page) } : {}),
      blocks: (Array.isArray(kids.results) ? kids.results : []).slice(0, LIMITS.pageSize).map(blockOut),
      next: kids.has_more === true && UUID.test(str(kids.next_cursor, 40)) ? kids.next_cursor : null,
    });
  }

  // Children of a block (expand a toggle, list, table, column...). Depth is limited by the UI; every request is bounded.
  if ((m = p.match(/^\/notion\/blocks\/([^/]+)\/children$/)) && req.method === "GET") {
    if (!UUID.test(m[1])) throw new Bad("bad_id");
    const cur = cursorOk(u.searchParams.get("cursor"));
    const kids = await notion(token, `/blocks/${m[1]}/children?page_size=${LIMITS.pageSize}` + (cur ? `&start_cursor=${cur}` : ""));
    return J({ blocks: (Array.isArray(kids.results) ? kids.results : []).slice(0, LIMITS.pageSize).map(blockOut), next: kids.has_more === true && UUID.test(str(kids.next_cursor, 40)) ? kids.next_cursor : null });
  }

  // ---- databases (v4.1): a database holds data sources; a data source is a table of rows (pages) ----
  // `child_database` blocks carry a DATABASE id: it is turned into data source ids here.
  if ((m = p.match(/^\/notion\/databases\/([^/]+)$/)) && req.method === "GET") {
    if (!UUID.test(m[1])) throw new Bad("bad_id");
    const d = await notion(token, `/databases/${m[1]}`);
    return J({ title: oneLine(richText(d.title, LIMITS.title)), sources: (Array.isArray(d.data_sources) ? d.data_sources : []).slice(0, 20).filter((x: any) => UUID.test(str(x?.id, 40))).map((x: any) => ({ id: x.id as string, name: oneLine(str(x.name, 100)) })) });
  }
  if ((m = p.match(/^\/notion\/datasources\/([^/]+)$/)) && req.method === "GET") {
    if (!UUID.test(m[1])) throw new Bad("bad_id");
    const ds = await notion(token, `/data_sources/${m[1]}`);
    return J({ id: m[1], title: oneLine(richText(ds.title, LIMITS.title)), columns: schemaOut(ds) });
  }
  if ((m = p.match(/^\/notion\/datasources\/([^/]+)\/rows$/)) && req.method === "GET") {
    if (!UUID.test(m[1])) throw new Bad("bad_id");
    const cur = cursorOk(u.searchParams.get("cursor"));
    const q = (u.searchParams.get("q") ?? "").trim();
    if (q.length > LIMITS.query) throw new Bad("bad_query");
    let filter: unknown;
    if (q) { // title-contains filter: needs the real name of the title column
      const t = schemaOut(await notion(token, `/data_sources/${m[1]}`)).find((c) => c.type === "title");
      if (t) filter = { property: t.name, title: { contains: q } };
    }
    const r = await notion(token, `/data_sources/${m[1]}/query`, {
      method: "POST", // a read: Notion's query endpoint is a POST
      body: { page_size: 25, sorts: [{ timestamp: "last_edited_time", direction: "descending" }], ...(filter ? { filter } : {}), ...(cur ? { start_cursor: cur } : {}) },
    });
    return J({ rows: (Array.isArray(r.results) ? r.results : []).filter((x: any) => x?.object === "page" && x.in_trash !== true && UUID.test(str(x.id, 40))).map(rowOut), next: r.has_more === true && UUID.test(str(r.next_cursor, 40)) ? r.next_cursor : null });
  }
  // One row with its column schema and current editable values (for the edit form).
  if ((m = p.match(/^\/notion\/rows\/([^/]+)$/)) && req.method === "GET") {
    if (!UUID.test(m[1])) throw new Bad("bad_id");
    const pg = await notion(token, `/pages/${m[1]}`);
    const dsId = str(pg?.parent?.data_source_id, 40);
    if (!isRow(pg) || !UUID.test(dsId)) throw new Bad("not_a_row");
    const cols = schemaOut(await notion(token, `/data_sources/${dsId}`));
    return J({ id: m[1], dataSourceId: dsId, title: pageTitle(pg), columns: cols, values: rowValues(pg, cols) });
  }

  // ---- writes (write sessions only; the "read" session uses an integration that Notion itself restricts) ----
  if (p === "/notion/pages" && req.method === "POST") {
    needWrite();
    const b = await c.json();
    if (typeof b.parentId !== "string" || !UUID.test(b.parentId)) throw new Bad("bad_id");
    const title = typeof b.title === "string" ? oneLine(b.title) : "";
    if (!title || title.length > LIMITS.title) throw new Bad("bad_title");
    const text = b.text === undefined ? "" : b.text;
    if (typeof text !== "string" || text.length > LIMITS.text) throw new Bad("bad_text");
    const ps = toParagraphs(text);
    if (ps.length > LIMITS.blocks) throw new Bad("too_many_blocks");
    await spend();
    const r = await notion(token, "/pages", {
      method: "POST",
      body: { parent: { page_id: b.parentId }, properties: { title: { title: [{ type: "text", text: { content: title } }] } }, ...(ps.length ? { children: paraBlocks(ps) } : {}) },
    });
    return J({ id: UUID.test(str(r.id, 40)) ? r.id : "", title });
  }

  if ((m = p.match(/^\/notion\/blocks\/([^/]+)\/append$/)) && req.method === "POST") {
    needWrite();
    if (!UUID.test(m[1])) throw new Bad("bad_id");
    const b = await c.json();
    if (typeof b.text !== "string" || b.text.length > LIMITS.text) throw new Bad("bad_text");
    const ps = toParagraphs(b.text);
    if (!ps.length) throw new Bad("bad_text");
    if (ps.length > LIMITS.blocks) throw new Bad("too_many_blocks");
    await spend();
    await notion(token, `/blocks/${m[1]}/children`, { method: "PATCH", body: { children: paraBlocks(ps) } }); // appended at the end; existing text is never touched
    return J({ ok: true, added: ps.length });
  }

  // New row. The Relay reads the data source's schema from Notion and builds the properties itself.
  if ((m = p.match(/^\/notion\/datasources\/([^/]+)\/rows$/)) && req.method === "POST") {
    needWrite();
    if (!UUID.test(m[1])) throw new Bad("bad_id");
    const b = await c.json();
    const cols = schemaOut(await notion(token, `/data_sources/${m[1]}`));
    const properties = buildProperties(cols, b.values, true);
    await spend();
    const r = await notion(token, "/pages", { method: "POST", body: { parent: { type: "data_source_id", data_source_id: m[1] }, properties } });
    return J({ id: UUID.test(str(r.id, 40)) ? r.id : "" });
  }

  // Edit a row's simple properties. `properties` is the ONLY field ever sent: no title/trash/icon/cover/archive/lock, no blocks.
  if ((m = p.match(/^\/notion\/rows\/([^/]+)\/update$/)) && req.method === "POST") {
    needWrite();
    if (!UUID.test(m[1])) throw new Bad("bad_id");
    const b = await c.json();
    const pg = await notion(token, `/pages/${m[1]}`);
    const dsId = str(pg?.parent?.data_source_id, 40);
    if (!isRow(pg) || !UUID.test(dsId)) throw new Bad("not_a_row"); // the parent comes from Notion, not from the browser
    const cols = schemaOut(await notion(token, `/data_sources/${dsId}`));
    const properties = buildProperties(cols, b.values, false);
    await spend();
    await notion(token, `/pages/${m[1]}`, { method: "PATCH", body: { properties } });
    return J({ ok: true });
  }

  return J({ error: "not_found" }, 404);
}
