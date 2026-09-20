import type { Env } from "./env";
import type { RouteCtx } from "./ctx";
import { APPS, scopesFor } from "./apps";
import { HttpErr, Bad } from "./errors";
import { ipKey, uaLabel } from "./security";
import { VENDORS, configured, creds, exchange } from "./vendors";
import { handleGmail } from "./gmail";
import { handleSpotify } from "./spotify";

export { Store } from "./store";

const SEC: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "Strict-Transport-Security": "max-age=31536000",
};
const MAX_BODY = 300_000;

const redirect = (url: string) => new Response(null, { status: 302, headers: { ...SEC, Location: url } });
const page = (text: string, status: number) => new Response(text, { status, headers: { ...SEC, "Content-Type": "text/plain" } });

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const u = new URL(req.url), p = u.pathname;
    const origin = req.headers.get("Origin");
    const okOrigin = origin === env.FRONTEND_ORIGIN;

    const J = (body: unknown, status = 200, extra: Record<string, string> = {}) => {
      const h = new Headers({ ...SEC, "Content-Type": "application/json", ...extra });
      if (okOrigin) { h.set("Access-Control-Allow-Origin", env.FRONTEND_ORIGIN); h.set("Vary", "Origin"); }
      return new Response(JSON.stringify(body), { status, headers: h });
    };

    if (req.method === "OPTIONS") {
      const h = new Headers({ ...SEC });
      if (okOrigin) {
        h.set("Access-Control-Allow-Origin", env.FRONTEND_ORIGIN);
        h.set("Access-Control-Allow-Methods", "GET,POST");
        h.set("Access-Control-Allow-Headers", "Authorization,Content-Type,X-Claim-Secret");
        h.set("Access-Control-Max-Age", "600");
        h.set("Vary", "Origin");
      }
      return new Response(null, { status: 204, headers: h });
    }

    // Setup helper: reports only which pieces are configured (booleans, no values). Works from any origin.
    if (p === "/health") {
      return new Response(JSON.stringify({
        ok: true,
        configured: { tokenKey: !!env.TOKEN_KEY, google: configured(env, "google"), spotify: configured(env, "spotify") },
      }), { headers: { ...SEC, "Content-Type": "application/json" } });
    }

    // Browser-navigation endpoints (OAuth) cannot send an Origin. Everything else must come from the frontend.
    // NOTE: Origin is a CORS/CSRF aid, not authentication (curl can forge it). Real protection = claim secret + capability.
    const isNav = p.startsWith("/oauth/");
    if (!isNav && !okOrigin) return J({ error: "forbidden_origin" }, 403);
    if (!env.TOKEN_KEY) { console.error("config_error: TOKEN_KEY missing"); return J({ error: "server_misconfigured" }, 500); }

    const store = env.STORE.getByName("main");
    const ip = ipKey(req.headers.get("cf-connecting-ip") || "unknown");
    const lim = (bucket: string, n: number) => store.hit(`${bucket}:${ip}`, n, 60_000);
    const bearerM = /^Bearer ([\w-]{20,100})$/.exec(req.headers.get("Authorization") || "");
    const bearer = bearerM ? bearerM[1] : null;
    const secret = req.headers.get("X-Claim-Secret") || "";
    const json = async (): Promise<Record<string, unknown>> => {
      const t = await req.text();
      if (t.length > MAX_BODY) throw new HttpErr(413, "too_large");
      try {
        const v = JSON.parse(t || "{}");
        if (!v || typeof v !== "object" || Array.isArray(v)) throw 0;
        return v as Record<string, unknown>;
      } catch { throw new Bad("bad_json"); }
    };
    const c: RouteCtx = { env, req, u, p, store, bearer, J, lim, json };
    let m: RegExpMatchArray | null;

    try {
      // ---------------- link transactions ----------------
      if (p === "/link/start" && req.method === "POST") {
        if (!(await lim("start", 10))) return J({ error: "rate_limited" }, 429);
        const b = await json();
        const app = typeof b.app === "string" && Object.hasOwn(APPS, b.app) ? (b.app as keyof typeof APPS) : null;
        if (app && !configured(env, APPS[app].vendor)) return J({ error: "app_not_configured" }, 503);
        const cf = (req as any).cf ?? {};
        const r = await store.newTx(b.app, b.access, b.claimHash, { country: cf.country, city: cf.city, ua: uaLabel(req.headers.get("User-Agent") || "") });
        if ("error" in r) return J({ error: r.error }, r.error === "busy" ? 503 : 400);
        return J(r);
      }
      if ((m = p.match(/^\/link\/status\/([\w-]+)$/)) && req.method === "GET") {
        if (!(await lim("status", 90))) return J({ error: "rate_limited" }, 429);
        return J({ status: await store.status(m[1], secret) });
      }
      if ((m = p.match(/^\/link\/claim\/([\w-]+)$/)) && req.method === "POST") {
        if (!(await lim("claim", 20))) return J({ error: "rate_limited" }, 429);
        const r = await store.claim(m[1], secret);
        return r ? J(r) : J({ error: "not_claimable" }, 409);
      }
      if ((m = p.match(/^\/link\/(info|confirm|cancel)\/([\w-]+)$/))) {
        if (!(await lim("phone", 30))) return J({ error: "rate_limited" }, 429);
        if (m[1] === "info" && req.method === "GET") {
          const i = await store.info(m[2]);
          return i ? J(i) : J({ error: "expired" }, 410);
        }
        if (m[1] === "confirm" && req.method === "POST") {
          const r = await store.confirm(m[2], (await json()).code);
          if ("nonce" in r) return J({ nonce: r.nonce });
          return J(r, r.error === "wrong_code" ? 403 : 410);
        }
        if (m[1] === "cancel" && req.method === "POST") {
          await store.cancel(m[2], secret || undefined);
          return J({ ok: true });
        }
      }

      // ---------------- OAuth (phone browser navigations) ----------------
      if ((m = p.match(/^\/oauth\/(google|spotify)$/)) && req.method === "GET") {
        if (!(await lim("oauth", 20))) return page("Too many requests", 429);
        const vendor = m[1] as "google" | "spotify";
        const b = await store.begin(u.searchParams.get("tx") || "", u.searchParams.get("n") || "");
        if (!b || b.vendor !== vendor || !configured(env, vendor)) return redirect(`${env.FRONTEND_URL}#/p/x/error?r=expired`);
        const cr = creds(env, vendor);
        const q = new URLSearchParams({
          client_id: cr.id, redirect_uri: cr.redirect, response_type: "code",
          scope: scopesFor(b.app, b.access), state: b.state,
          code_challenge: b.challenge, code_challenge_method: "S256", ...VENDORS[vendor].extra,
        });
        return redirect(VENDORS[vendor].authUrl + "?" + q);
      }
      if ((m = p.match(/^\/oauth\/(google|spotify)\/callback$/)) && req.method === "GET") {
        if (!(await lim("cb", 20))) return page("Too many requests", 429);
        const vendor = m[1] as "google" | "spotify";
        const s = await store.takeState(u.searchParams.get("state") || "");
        if (!s) return redirect(`${env.FRONTEND_URL}#/p/x/error?r=state`);
        const back = (r: string) => redirect(`${env.FRONTEND_URL}#/p/${s.id}/error?r=${r}`);
        if (s.vendor !== vendor) { await store.fail(s.id); return back("state"); }
        const code = u.searchParams.get("code");
        if (u.searchParams.get("error") || !code) { await store.fail(s.id); return back("denied"); }
        let ex;
        try { ex = await exchange(env, vendor, code, s.verifier); }
        catch { await store.fail(s.id); return back("failed"); }
        const r = await store.approve(s.id, ex);
        if (r === "scope") return back("scope");
        if (r !== "ok") return back("state");
        return redirect(`${env.FRONTEND_URL}#/p/${s.id}/done`);
      }

      // ---------------- authenticated ----------------
      if (p === "/session/revoke" && req.method === "POST") {
        if (!(await lim("revoke", 20))) return J({ error: "rate_limited" }, 429);
        if (bearer) await store.revoke(bearer); // also revokes the token at the vendor (Google) in the background
        return J({ ok: true });
      }
      try {
        if (p.startsWith("/gmail/")) return await handleGmail(c);
        if (p.startsWith("/spotify/")) return await handleSpotify(c);
      } catch (e) {
        // The vendor rejected our token: the session is useless, remove it.
        if (e instanceof HttpErr && e.status === 401 && bearer) await store.revoke(bearer);
        throw e;
      }
      return J({ error: "not_found" }, 404);
    } catch (e) {
      if (e instanceof HttpErr) return J({ error: e.code }, e.status, e.retryAfter ? { "Retry-After": e.retryAfter } : {});
      console.error("event: internal_error"); // never log the error object: it could contain request data
      return J({ error: "internal" }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
