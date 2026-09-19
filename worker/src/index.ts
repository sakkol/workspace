import { DurableObject } from "cloudflare:workers";

interface Env {
  STORE: DurableObjectNamespace<Store>;
  GOOGLE_CLIENT_ID: string; GOOGLE_CLIENT_SECRET: string; REDIRECT_URI: string;
  FRONTEND_ORIGIN: string; FRONTEND_URL: string;
}
const TX_TTL = 150_000, MAX_LIFE = 30 * 60_000, IDLE = 5 * 60_000;
const SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

const enc = new TextEncoder();
const b64u = (b: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const rnd = (n: number) => b64u(crypto.getRandomValues(new Uint8Array(n)));
const sha = async (s: string) => b64u(await crypto.subtle.digest("SHA-256", enc.encode(s)));

type Status = "pending" | "confirmed" | "authorizing" | "exchanging" | "approved" | "consumed" | "cancelled";
interface Tx { code: string; state: string; verifier: string; challenge: string; status: Status; nonce?: string; token?: string; exp: number }
interface Sess { provider: "google"; token: string; created: number; last: number }

// Single Durable Object = atomic, single-threaded state. All single-use guarantees rely on this.
export class Store extends DurableObject<Env> {
  private async sched() { if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Date.now() + 30_000); }
  private async tx(id: string) {
    const t = await this.ctx.storage.get<Tx>("t:" + id);
    if (!t) return null;
    if (t.exp < Date.now()) { await this.ctx.storage.delete("t:" + id); return null; }
    return t;
  }
  private save(id: string, t: Tx) { return this.ctx.storage.put("t:" + id, t); }

  async newTx() {
    const id = rnd(16), verifier = rnd(32);
    const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, "0");
    const t: Tx = { code, state: id + "." + rnd(16), verifier, challenge: await sha(verifier), status: "pending", exp: Date.now() + TX_TTL };
    await this.save(id, t); await this.sched();
    return { id, code, exp: t.exp };
  }
  async status(id: string) {
    const t = await this.tx(id); if (!t) return "expired";
    return ["confirmed", "authorizing", "exchanging"].includes(t.status) ? "pending" : t.status;
  }
  async info(id: string) { const t = await this.tx(id); return t && t.status === "pending" ? { code: t.code, exp: t.exp } : null; }
  async confirm(id: string) {
    const t = await this.tx(id); if (!t || t.status !== "pending") return null;
    t.status = "confirmed"; t.nonce = rnd(16); await this.save(id, t); return t.nonce;
  }
  async begin(id: string, nonce: string) {
    const t = await this.tx(id); if (!t || t.status !== "confirmed" || t.nonce !== nonce) return null;
    t.status = "authorizing"; delete t.nonce; await this.save(id, t); return { state: t.state, challenge: t.challenge };
  }
  async takeState(state: string) {
    const id = state.split(".")[0]; const t = await this.tx(id);
    if (!t || t.status !== "authorizing" || t.state !== state) return null;
    t.status = "exchanging"; await this.save(id, t); return { id, verifier: t.verifier };
  }
  async approve(id: string, token: string) {
    const t = await this.tx(id); if (!t || t.status !== "exchanging") return false;
    t.status = "approved"; t.token = token; await this.save(id, t); return true;
  }
  async fail(id: string) { const t = await this.tx(id); if (t) { t.status = "cancelled"; delete t.token; await this.save(id, t); } }
  async cancel(id: string) {
    const t = await this.tx(id);
    if (t && ["pending", "confirmed", "authorizing"].includes(t.status)) { t.status = "cancelled"; await this.save(id, t); }
  }
  async claim(id: string) {
    const t = await this.tx(id); if (!t || t.status !== "approved" || !t.token) return null;
    const cap = rnd(32), now = Date.now();
    const s: Sess = { provider: "google", token: t.token, created: now, last: now };
    await this.ctx.storage.put("s:" + (await sha(cap)), s);
    t.status = "consumed"; delete t.token; await this.save(id, t); await this.sched();
    return { cap, exp: now + MAX_LIFE };
  }
  async auth(cap: string) {
    const k = "s:" + (await sha(cap)); const s = await this.ctx.storage.get<Sess>(k); if (!s) return null;
    const now = Date.now();
    if (now > s.created + MAX_LIFE || now - s.last > IDLE) { await this.ctx.storage.delete(k); return null; }
    s.last = now; await this.ctx.storage.put(k, s);
    return { token: s.token, exp: s.created + MAX_LIFE };
  }
  async revoke(cap: string) { await this.ctx.storage.delete("s:" + (await sha(cap))); }
  async hit(key: string, limit: number, windowMs: number) {
    const k = "r:" + key, now = Date.now();
    let r = await this.ctx.storage.get<{ n: number; reset: number }>(k);
    if (!r || r.reset < now) r = { n: 0, reset: now + windowMs };
    r.n++; await this.ctx.storage.put(k, r); await this.sched();
    return r.n <= limit;
  }
  async alarm() {
    const now = Date.now(); const all = await this.ctx.storage.list<any>(); let left = 0;
    for (const [k, v] of all) {
      const dead = k.startsWith("t:") ? v.exp < now : k.startsWith("s:") ? now > v.created + MAX_LIFE || now - v.last > IDLE : v.reset < now;
      if (dead) await this.ctx.storage.delete(k); else left++;
    }
    if (left) await this.ctx.storage.setAlarm(now + 30_000);
  }
}

const SEC = {
  "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "Strict-Transport-Security": "max-age=31536000",
};
const out = (env: Env, req: Request, body: unknown, status = 200) => {
  const h = new Headers({ ...SEC, "Content-Type": "application/json" });
  if (req.headers.get("Origin") === env.FRONTEND_ORIGIN) { h.set("Access-Control-Allow-Origin", env.FRONTEND_ORIGIN); h.set("Vary", "Origin"); }
  return new Response(JSON.stringify(body), { status, headers: h });
};
const redirect = (url: string) => new Response(null, { status: 302, headers: { ...SEC, Location: url } });

async function gmail(token: string, path: string) {
  const r = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/" + path, { headers: { Authorization: "Bearer " + token } });
  if (!r.ok) throw new Error(String(r.status));
  return r.json<any>();
}
const hdr = (m: any, n: string) => m.payload?.headers?.find((h: any) => h.name.toLowerCase() === n)?.value ?? "";
const dec = (d: string) => { const b = atob(d.replace(/-/g, "+").replace(/_/g, "/")); return new TextDecoder().decode(Uint8Array.from(b, c => c.charCodeAt(0))); };
function bodyText(p: any): string {
  const parts: any[] = []; const walk = (x: any) => { parts.push(x); (x.parts || []).forEach(walk); }; walk(p);
  const plain = parts.find(x => x.mimeType === "text/plain" && x.body?.data);
  if (plain) return dec(plain.body.data);
  const html = parts.find(x => x.mimeType === "text/html" && x.body?.data);
  if (!html) return "(no readable text content)";
  return dec(html.body.data).replace(/<(script|style)[\s\S]*?<\/\1>/gi, "").replace(/<(br|\/p|\/div|\/tr|\/li)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\n{3,}/g, "\n\n").trim();
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const u = new URL(req.url), p = u.pathname, store = env.STORE.getByName("main");
    const origin = req.headers.get("Origin");
    if (req.method === "OPTIONS") {
      const h = new Headers({ ...SEC });
      if (origin === env.FRONTEND_ORIGIN) {
        h.set("Access-Control-Allow-Origin", origin); h.set("Access-Control-Allow-Methods", "GET,POST");
        h.set("Access-Control-Allow-Headers", "Authorization,Content-Type"); h.set("Access-Control-Max-Age", "600"); h.set("Vary", "Origin");
      }
      return new Response(null, { status: 204, headers: h });
    }
    const J = (b: unknown, s = 200) => out(env, req, b, s);
    const isNav = p.startsWith("/oauth/");
    if (!isNav && origin !== env.FRONTEND_ORIGIN) return J({ error: "forbidden_origin" }, 403);
    const ip = req.headers.get("cf-connecting-ip") || "x";
    const lim = (b: string, n: number) => store.hit(`${b}:${ip}`, n, 60_000);
    let m: RegExpMatchArray | null;

    try {
      if (p === "/link/start" && req.method === "POST") {
        if (!(await lim("start", 10))) return J({ error: "rate_limited" }, 429);
        return J(await store.newTx());
      }
      if ((m = p.match(/^\/link\/status\/([\w-]+)$/))) {
        if (!(await lim("status", 90))) return J({ error: "rate_limited" }, 429);
        return J({ status: await store.status(m[1]) });
      }
      if ((m = p.match(/^\/link\/claim\/([\w-]+)$/)) && req.method === "POST") {
        if (!(await lim("claim", 20))) return J({ error: "rate_limited" }, 429);
        const c = await store.claim(m[1]); return c ? J(c) : J({ error: "not_claimable" }, 409);
      }
      if ((m = p.match(/^\/link\/(info|confirm|cancel)\/([\w-]+)$/))) {
        if (!(await lim("phone", 30))) return J({ error: "rate_limited" }, 429);
        if (m[1] === "info") { const i = await store.info(m[2]); return i ? J(i) : J({ error: "expired" }, 410); }
        if (m[1] === "cancel") { await store.cancel(m[2]); return J({ ok: true }); }
        const n = await store.confirm(m[2]); return n ? J({ nonce: n }) : J({ error: "expired" }, 410);
      }
      if (p === "/oauth/google") {
        if (!(await lim("oauth", 20))) return new Response("Too many requests", { status: 429, headers: SEC });
        const b = await store.begin(u.searchParams.get("tx") || "", u.searchParams.get("n") || "");
        if (!b) return redirect(`${env.FRONTEND_URL}#/p/x/error?r=expired`);
        const q = new URLSearchParams({
          client_id: env.GOOGLE_CLIENT_ID, redirect_uri: env.REDIRECT_URI, response_type: "code", scope: SCOPE,
          state: b.state, code_challenge: b.challenge, code_challenge_method: "S256", prompt: "select_account",
        });
        return redirect("https://accounts.google.com/o/oauth2/v2/auth?" + q);
      }
      if (p === "/oauth/google/callback") {
        if (!(await lim("cb", 20))) return new Response("Too many requests", { status: 429, headers: SEC });
        const s = await store.takeState(u.searchParams.get("state") || "");
        if (!s) return redirect(`${env.FRONTEND_URL}#/p/x/error?r=state`);
        const code = u.searchParams.get("code");
        if (u.searchParams.get("error") || !code) { await store.fail(s.id); return redirect(`${env.FRONTEND_URL}#/p/${s.id}/error?r=denied`); }
        const r = await fetch("https://oauth2.googleapis.com/token", {
          method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
            redirect_uri: env.REDIRECT_URI, grant_type: "authorization_code", code_verifier: s.verifier }),
        });
        const j = await r.json<any>();
        if (j.refresh_token) console.error("security_event: unexpected_refresh_token (discarded)");
        if (!r.ok || !j.access_token) { await store.fail(s.id); return redirect(`${env.FRONTEND_URL}#/p/${s.id}/error?r=failed`); }
        await store.approve(s.id, j.access_token);
        return redirect(`${env.FRONTEND_URL}#/p/${s.id}/done`);
      }

      // ---- authenticated endpoints ----
      const bearer = /^Bearer (.+)$/.exec(req.headers.get("Authorization") || "");
      if (p === "/session/revoke" && req.method === "POST") {
        if (!(await lim("revoke", 20))) return J({ error: "rate_limited" }, 429);
        if (bearer) await store.revoke(bearer[1]); return J({ ok: true });
      }
      if (p.startsWith("/gmail/")) {
        if (!(await lim("gmail", 120))) return J({ error: "rate_limited" }, 429);
        const s = bearer ? await store.auth(bearer[1]) : null;
        if (!s) return J({ error: "session_expired" }, 401);
        try {
          if (p === "/gmail/profile") {
            const l = await gmail(s.token, "labels/INBOX");
            return J({ unread: l.messagesUnread ?? 0, total: l.messagesTotal ?? 0, exp: s.exp });
          }
          if (p === "/gmail/messages") {
            const l = await gmail(s.token, "messages?labelIds=INBOX&maxResults=20");
            const items = await Promise.all((l.messages || []).map(async (x: any) => {
              const g = await gmail(s.token, `messages/${x.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`);
              return { id: g.id, from: hdr(g, "from"), subject: hdr(g, "subject"), date: hdr(g, "date"), snippet: g.snippet, unread: (g.labelIds || []).includes("UNREAD") };
            }));
            return J({ messages: items });
          }
          if ((m = p.match(/^\/gmail\/messages\/([\w-]+)$/))) {
            const g = await gmail(s.token, `messages/${m[1]}?format=full`);
            return J({ id: g.id, threadId: g.threadId, from: hdr(g, "from"), to: hdr(g, "to"), subject: hdr(g, "subject"), date: hdr(g, "date"), text: bodyText(g.payload) });
          }
        } catch (e) {
          if ((e as Error).message === "401") { await store.revoke(bearer![1]); return J({ error: "session_expired" }, 401); }
          return J({ error: "gmail_unavailable" }, 502);
        }
      }
      return J({ error: "not_found" }, 404);
    } catch {
      console.error("event: internal_error");
      return J({ error: "internal" }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
