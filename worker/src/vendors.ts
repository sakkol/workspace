import type { Env } from "./env";
import type { VendorId } from "./apps";

export interface VendorDef {
  /** Microsoft's URLs contain the tenant, so use authUrlFor()/tokenUrlFor(), not these fields, when calling the vendor. */
  authUrl: string;
  tokenUrl: string;
  /** Send the requested scopes in the token request too (Microsoft's documented token request includes `scope`). */
  scopeInTokenRequest?: boolean;
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
//  * never add offline_access (Microsoft) - it is what makes Microsoft issue a refresh token. Do NOT use MSAL: it adds it.
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
  microsoft: {
    authUrl: "https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize",
    tokenUrl: "https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token",
    scopeInTokenRequest: true,
    extra: { prompt: "select_account" },
    clientAuth: "body",
    expectsRefreshToken: false, // no offline_access is requested, so a refresh token is unexpected: discard + log the event
    revoke: null, // Microsoft has no revocation endpoint for access tokens: the Relay just deletes its copy (see docs/SECURITY.md)
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
  if (v === "google") return { id: env.GOOGLE_CLIENT_ID, secret: env.GOOGLE_CLIENT_SECRET, redirect: env.GOOGLE_REDIRECT_URI };
  if (v === "microsoft") return { id: env.MICROSOFT_CLIENT_ID ?? "", secret: env.MICROSOFT_CLIENT_SECRET ?? "", redirect: env.MICROSOFT_REDIRECT_URI ?? "" };
  return { id: env.SPOTIFY_CLIENT_ID ?? "", secret: env.SPOTIFY_CLIENT_SECRET ?? "", redirect: env.SPOTIFY_REDIRECT_URI ?? "" };
}

const TENANT = /^(consumers|organizations|common|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;
/** Default is "consumers" (personal Microsoft accounts). An invalid value is NOT repaired: the vendor is reported as not configured (R20). */
export const tenantOf = (env: Env): string | null => {
  const t = (env.MICROSOFT_TENANT ?? "").trim() || "consumers";
  return TENANT.test(t) ? t : null;
};

export const configured = (env: Env, v: VendorId) => {
  const c = creds(env, v);
  if (v === "microsoft" && !tenantOf(env)) return false;
  return !!(c.id && c.secret && c.redirect);
};

const fill = (env: Env, v: VendorId, url: string) => (v === "microsoft" ? url.replace("{tenant}", tenantOf(env) ?? "invalid") : url);
export const authUrlFor = (env: Env, v: VendorId) => fill(env, v, VENDORS[v].authUrl);
export const tokenUrlFor = (env: Env, v: VendorId) => fill(env, v, VENDORS[v].tokenUrl);

export interface Exchanged { token: string; tokenLifeMs: number; scope: string }

export async function exchange(env: Env, vendor: VendorId, code: string, verifier: string, scope = ""): Promise<Exchanged> {
  const c = creds(env, vendor), V = VENDORS[vendor];
  const body = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: c.redirect, code_verifier: verifier });
  if (V.scopeInTokenRequest && scope) body.set("scope", scope);
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
  if (V.clientAuth === "basic") headers.Authorization = "Basic " + btoa(`${c.id}:${c.secret}`);
  else { body.set("client_id", c.id); body.set("client_secret", c.secret); }
  const r = await fetch(tokenUrlFor(env, vendor), { method: "POST", headers, body });
  const j = (await r.json()) as Record<string, unknown>;
  // Never persist a refresh token. Log only the fact, never the value.
  if (j.refresh_token && !V.expectsRefreshToken) console.error("security_event: unexpected_refresh_token (discarded)");
  if (!r.ok || typeof j.access_token !== "string") throw new Error("exchange_failed");
  return { token: j.access_token, tokenLifeMs: (Number(j.expires_in) || 3600) * 1000, scope: String(j.scope ?? "") };
}
