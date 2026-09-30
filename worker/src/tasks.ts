// Google Tasks (v3.1). Same rules as gmail.ts: route allow-list, strict ID regexes, whitelisted fields, the Relay builds every
// Google request from structured fields (R13). There is deliberately NO delete route (R14): a task can be completed, not removed.
import type { RouteCtx } from "./ctx";
import { HttpErr, Bad } from "./errors";

const BASE = "https://tasks.googleapis.com/tasks/v1";
const ID = /^[A-Za-z0-9_-]{1,200}$/; // Tasks list and task ids
const PAGE = /^[A-Za-z0-9_\-=.+/~]{1,1000}$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
export const LIMITS = { title: 500, notes: 8000 };
const MAX_TASKS = 100; // per page

type Method = "GET" | "POST" | "PATCH"; // DELETE is deliberately not representable
async function gtasks(token: string, path: string, init?: { method?: Method; body?: unknown }) {
  const method = init?.method ?? "GET";
  if ((method as string) === "DELETE") throw new Error("delete_not_allowed");
  const r = await fetch(BASE + path, {
    method,
    headers: { Authorization: "Bearer " + token, ...(init?.body ? { "Content-Type": "application/json" } : {}) },
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
  if (r.status === 401) throw new HttpErr(401, "session_expired");
  if (r.status === 403) throw new HttpErr(403, "tasks_forbidden"); // also: Google Tasks API not enabled in the Cloud project
  if (r.status === 404) throw new HttpErr(404, "not_found");
  if (r.status === 400) throw new HttpErr(400, "tasks_bad_request");
  if (r.status === 429) throw new HttpErr(429, "tasks_rate_limited", r.headers.get("Retry-After"));
  if (!r.ok) throw new HttpErr(502, "tasks_unavailable");
  return r.status === 204 ? {} : ((await r.json()) as any);
}

const str = (x: unknown, max: number) => (typeof x === "string" ? x.slice(0, max) : "");
/** Tasks stores only a date for `due` (the time part is ignored). We accept and return "YYYY-MM-DD". */
export function validDate(s: unknown): s is string {
  if (typeof s !== "string") return false;
  const m = DATE.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] && +m[1] >= 1970 && +m[1] <= 2100;
}
const dueOut = (d: unknown) => (typeof d === "string" && /^\d{4}-\d{2}-\d{2}/.test(d) ? d.slice(0, 10) : "");
const oneLine = (s: string) => s.replace(/[\r\n\0\t]+/g, " ").trim();

export const taskOut = (t: any) => ({
  id: str(t?.id, 200), title: str(t?.title, LIMITS.title), notes: str(t?.notes, LIMITS.notes),
  status: t?.status === "completed" ? "completed" : "needsAction",
  due: dueOut(t?.due), parent: ID.test(str(t?.parent, 200)) ? str(t?.parent, 200) : "", updated: str(t?.updated, 40),
});

/** Validate the fields the browser may send. Anything else is ignored; unknown keys never reach Google. */
export function taskFields(b: Record<string, unknown>, creating: boolean) {
  const out: Record<string, unknown> = {};
  if (b.title !== undefined) {
    if (typeof b.title !== "string") throw new Bad("bad_title");
    const t = oneLine(b.title);
    if (!t || t.length > LIMITS.title) throw new Bad("bad_title");
    out.title = t;
  } else if (creating) throw new Bad("bad_title");
  if (b.notes !== undefined) {
    if (typeof b.notes !== "string" || b.notes.length > LIMITS.notes) throw new Bad("bad_notes");
    out.notes = b.notes.replace(/\0/g, "");
  }
  if (b.due !== undefined) {
    if (b.due === null || b.due === "") out.due = null; // clears the date
    else if (validDate(b.due)) out.due = b.due + "T00:00:00.000Z";
    else throw new Bad("bad_due");
  }
  if (b.status !== undefined) {
    if (creating || (b.status !== "needsAction" && b.status !== "completed")) throw new Bad("bad_status");
    out.status = b.status;
    if (b.status === "needsAction") out.completed = null; // Google requires this to reopen a task
  }
  if (!Object.keys(out).length) throw new Bad("nothing_to_change");
  return out;
}

export async function handleTasks(c: RouteCtx): Promise<Response> {
  const { p, req, u, J, store, bearer } = c;
  if (!(await c.lim("tasks", 120))) return J({ error: "rate_limited" }, 429);
  const s = bearer ? await store.auth(bearer, "tasks") : null;
  if (!s) return J({ error: "session_expired" }, 401);
  const token = s.token;
  const needWrite = () => { if (s.access !== "write") throw new HttpErr(403, "read_only"); };
  // Spent only after the request has been validated, so a typo cannot use up the session's allowance.
  const spend = async () => {
    if (!(await c.lim("tasks-write", 60))) throw new HttpErr(429, "rate_limited");
    const slot = await store.writeSlot(bearer!, "tasks"); // per-session counter, kept in the Durable Object (R14)
    if (!slot.ok) throw new HttpErr(slot.reason === "write_limit" ? 429 : 401, slot.reason);
  };
  let m: RegExpMatchArray | null;

  if (p === "/tasks/lists" && req.method === "GET") {
    const r = await gtasks(token, "/users/@me/lists?maxResults=100");
    return J({ lists: (Array.isArray(r.items) ? r.items : []).filter((l: any) => ID.test(str(l?.id, 200))).map((l: any) => ({ id: str(l.id, 200), title: str(l.title, 300) })) });
  }

  if ((m = p.match(/^\/tasks\/lists\/([^/]+)\/tasks$/))) {
    if (!ID.test(m[1])) throw new Bad("bad_id");
    const lid = encodeURIComponent(m[1]);
    if (req.method === "GET") {
      const done = u.searchParams.get("completed") === "1";
      const pt = u.searchParams.get("pageToken") || "";
      if (pt && !PAGE.test(pt)) throw new Bad("bad_page");
      // Tasks completed in Google's own apps only appear with showHidden=true.
      const q = new URLSearchParams({ maxResults: String(MAX_TASKS), showCompleted: done ? "true" : "false", showHidden: done ? "true" : "false" });
      if (pt) q.set("pageToken", pt);
      const r = await gtasks(token, `/lists/${lid}/tasks?${q}`);
      const tasks = (Array.isArray(r.items) ? r.items : []).filter((t: any) => ID.test(str(t?.id, 200))).map(taskOut);
      return J({ tasks: done ? tasks : tasks.filter((t: any) => t.status !== "completed"), nextPageToken: PAGE.test(str(r.nextPageToken, 1000)) ? r.nextPageToken : null });
    }
    if (req.method === "POST") { // create
      needWrite();
      const f = taskFields(await c.json(), true);
      await spend();
      return J({ task: taskOut(await gtasks(token, `/lists/${lid}/tasks`, { method: "POST", body: f })) });
    }
  }

  // Update one task: title, notes, due date, done / not done. Nothing else can be changed, and nothing can be deleted.
  if ((m = p.match(/^\/tasks\/lists\/([^/]+)\/tasks\/([^/]+)\/update$/)) && req.method === "POST") {
    needWrite();
    if (!ID.test(m[1]) || !ID.test(m[2])) throw new Bad("bad_id");
    const f = taskFields(await c.json(), false);
    await spend();
    return J({ task: taskOut(await gtasks(token, `/lists/${encodeURIComponent(m[1])}/tasks/${encodeURIComponent(m[2])}`, { method: "PATCH", body: f })) });
  }

  return J({ error: "not_found" }, 404);
}
