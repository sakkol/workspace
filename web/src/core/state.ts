// In-memory application state. NOTHING here is ever written to cookies, localStorage, sessionStorage or IndexedDB.

export type AppId = "gmail" | "spotify";
export type Access = "read" | "write";
export interface Cap { cap: string; expAt: number; access: Access }

/** One capability per unlocked app. The only credentials this page ever holds. */
export const caps = new Map<AppId, Cap>();

export type View =
  | { n: "launcher" }
  | { n: "unlock"; app: AppId; access: Access }
  | { n: "app"; app: AppId }
  | { n: "phone"; id: string; sub: string };

export let view: View = { n: "launcher" };
let renderer: () => void = () => {};
export const setRenderer = (f: () => void) => { renderer = f; };
export const rerender = () => renderer();
export function go(v: View) { view = v; renderer(); }

// timers + leave-handlers are cleared/run on every render
let timers: number[] = [];
let leaves: Array<() => void> = [];
export const every = (fn: () => void, ms: number) => { timers.push(window.setInterval(fn, ms)); };
export const onLeave = (fn: () => void) => { leaves.push(fn); };
export function resetView() {
  timers.forEach((t) => clearInterval(t)); timers = [];
  const l = leaves; leaves = []; l.forEach((f) => f());
}

// each app clears its own in-memory data (message lists, drafts, track results) when it is locked
const wipers = new Map<AppId, () => void>();
export const registerWiper = (a: AppId, f: () => void) => { wipers.set(a, f); };

let notice = "";
export const setNotice = (s: string) => { notice = s; };
export const takeNotice = () => { const n = notice; notice = ""; return n; };

export const APP_NAMES: Record<AppId, string> = { gmail: "Gmail", spotify: "Spotify" };

/** Forget an app's capability and data locally. */
export function dropApp(app: AppId, why?: string) {
  caps.delete(app);
  wipers.get(app)?.();
  if (why) notice = why;
}

/** Called when the server (or the timer) ends a session while the user might be looking at it. */
export function sessionEnded(app: AppId, why: string) {
  dropApp(app, why);
  if (view.n === "app" && view.app === app) go({ n: "launcher" });
  else if (view.n === "launcher") rerender();
}
