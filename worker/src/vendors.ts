import type { Env } from "./env";
import type { VendorId } from "./apps";

export interface VendorDef {
  authUrl: string;
  tokenUrl: string;
  /** Extra authorize-URL parameters. */
  extra: Record<string, string>;
  clientAuth: "body" | "basic";
  /** Spotify always returns a refresh token; we discard it. For Google a refresh token would be unexpected. */
  expectsRefreshToken: boolean;
  /** Best-effort token revocation at the vendor (null = vendor has no such endpoint). */
  revoke: ((token: string) => Promise<unknown>) | null;
}

// HARD RULES (see docs/SECURITY.md):
//  * never add access_type=offline (no refresh tokens)
//  * never add include_granted_scopes (it would merge grants from different apps into one token)
export const VENDORS: Record<VendorId, VendorDef> = {
  google: {
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    extra: { prompt: "select_account" },
    clientAuth: "body",
    expectsRefreshToken: false,
    revoke: (t) =>
      fetch("https://oauth2.googleapis.com/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: t }),
      }),
  },
  spotify: {
    authUrl: "https://accounts.spotify.com/authorize",
    tokenUrl: "https://accounts.spotify.com/api/token",
    extra: { show_dialog: "true" },
    clientAuth: "basic",
    expectsRefreshToken: true,
    revoke: null,
  },
};

export function creds(env: Env, v: VendorId) {
  return v === "google"
    ? { id: env.GOOGLE_CLIENT_ID, secret: env.GOOGLE_CLIENT_SECRET, redirect: env.GOOGLE_REDIRECT_URI }
    : { id: env.SPOTIFY_CLIENT_ID ?? "", secret: env.SPOTIFY_CLIENT_SECRET ?? "", redirect: env.SPOTIFY_REDIRECT_URI ?? "" };
}
export const configured = (env: Env, v: VendorId) => {
  const c = creds(env, v);
  return !!(c.id && c.secret && c.redirect);
};

export interface Exchanged { token: string; tokenLifeMs: number; scope: string }

export async function exchange(env: Env, vendor: VendorId, code: string, verifier: string): Promise<Exchanged> {
  const c = creds(env, vendor), V = VENDORS[vendor];
  const body = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: c.redirect, code_verifier: verifier });
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
  if (V.clientAuth === "basic") headers.Authorization = "Basic " + btoa(`${c.id}:${c.secret}`);
  else { body.set("client_id", c.id); body.set("client_secret", c.secret); }
  const r = await fetch(V.tokenUrl, { method: "POST", headers, body });
  const j = (await r.json()) as Record<string, unknown>;
  // Never persist a refresh token. Log only the fact, never the value.
  if (j.refresh_token && !V.expectsRefreshToken) console.error("security_event: unexpected_refresh_token (discarded)");
  if (!r.ok || typeof j.access_token !== "string") throw new Error("exchange_failed");
  return { token: j.access_token, tokenLifeMs: (Number(j.expires_in) || 3600) * 1000, scope: String(j.scope ?? "") };
}
