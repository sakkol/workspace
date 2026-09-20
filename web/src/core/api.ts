import { caps, AppId, dropApp, sessionEnded, APP_NAMES } from "./state";

export const RELAY = ((import.meta.env.VITE_RELAY_URL as string) || "").replace(/\/+$/, "");

export class ApiError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}

async function call(path: string, init: RequestInit, headers: Record<string, string>) {
  let r: Response;
  try {
    r = await fetch(RELAY + path, { ...init, credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer", headers });
  } catch { throw new ApiError(0, "network"); }
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(r.status, typeof body?.error === "string" ? body.error : "error");
  return body;
}

/** Unauthenticated Relay call (linking). */
export const relay = (path: string, init: RequestInit = {}, extra: Record<string, string> = {}) =>
  call(path, init, { ...(init.body ? { "Content-Type": "application/json" } : {}), ...extra });

/** Authenticated call for one app. Uses ONLY that app's capability, sent in the Authorization header. */
export async function api(app: AppId, path: string, init: RequestInit = {}) {
  const c = caps.get(app);
  if (!c) throw new ApiError(401, "locked");
  try {
    return await call(path, init, { ...(init.body ? { "Content-Type": "application/json" } : {}), Authorization: "Bearer " + c.cap });
  } catch (e) {
    if (e instanceof ApiError && e.status === 401 && caps.get(app) === c) sessionEnded(app, `${APP_NAMES[app]} session ended. Unlock it again.`);
    throw e;
  }
}
export const post = (app: AppId, path: string, body?: unknown) =>
  api(app, path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });

/** Lock one app: forget locally first (always works), then ask the Relay to revoke. */
export async function lockApp(app: AppId) {
  const c = caps.get(app);
  dropApp(app);
  if (c) { try { await call("/session/revoke", { method: "POST" }, { Authorization: "Bearer " + c.cap }); } catch { /* server TTL is the fallback */ } }
}
export async function lockAll() { await Promise.all([...caps.keys()].map(lockApp)); }

const MESSAGES: Record<string, string> = {
  network: "Network problem. Check the connection and try again.",
  rate_limited: "Too many requests. Wait a moment and try again.",
  read_only: "This session is read-only. Lock Gmail and unlock it with “Read & write”.",
  send_limit: "Send limit reached for this session (10 messages). Lock and unlock to continue.",
  bad_recipient: "One of the addresses is not valid.", no_recipient: "Add at least one recipient.",
  too_many_recipients: "Too many recipients (10 maximum).", subject_too_long: "The subject is too long.", body_too_long: "The message is too long.",
  header_injection: "Line breaks are not allowed in addresses or subjects.",
  gmail_unavailable: "Gmail is unavailable right now.", gmail_forbidden: "Google refused this request (permission missing). Lock and unlock again.",
  gmail_rate_limited: "Gmail asked us to slow down. Try again shortly.",
  premium_required: "Spotify needs a Premium account to control playback.",
  no_active_device: "No active Spotify device. Open Spotify on your phone or speaker, then press Refresh.",
  spotify_forbidden: "Spotify refused this request. Your account may not be on the app's allowed-users list.",
  spotify_rate_limited: "Spotify asked us to slow down. Try again shortly.", spotify_unavailable: "Spotify is unavailable right now.",
  app_not_configured: "This app is not set up on the Relay yet (see SETUP-STEPS.md).", busy: "The Relay is busy. Try again in a minute.",
  server_misconfigured: "The Relay is missing configuration (TOKEN_KEY). See SETUP-STEPS.md.",
};
export const errText = (e: unknown) => (e instanceof ApiError ? MESSAGES[e.code] ?? "Something went wrong." : "Something went wrong.");
