// All single-use / expiry / limit logic lives here, with NO Cloudflare imports, so it can be unit-tested in Node.
// The Durable Object (store.ts) is a thin wrapper: one DO instance = atomic, single-threaded state.

import { APPS, AppId, Access, VendorId, isAccess, isApp, scopeList, scopesFor } from "./apps";
import { rnd, sha, timingSafeEqual } from "./security";

export const TX_TTL = 150_000; // link transaction lifetime: 2.5 min
export const MAX_PENDING = 100; // cap on simultaneous transactions
export const CODE_TRIES = 3; // wrong-code attempts before a transaction is cancelled
export const MAX_SENDS = 10; // Gmail messages per session

export interface KV {
  get<T = unknown>(k: string): Promise<T | undefined>;
  put(k: string, v: unknown): Promise<void>;
  delete(k: string): Promise<unknown>;
  list<T = unknown>(o?: { prefix?: string }): Promise<Map<string, T>>;
  getAlarm(): Promise<number | null>;
  setAlarm(t: number): Promise<void>;
}
export interface Hooks {
  seal(plain: string, aad: string): Promise<string>;
  open(sealed: string, aad: string): Promise<string>;
  /** Best-effort revocation at the vendor. Must not throw and must never log the token. */
  revoke(app: AppId, token: string): void;
  now?: () => number;
}

export type Status = "pending" | "confirmed" | "authorizing" | "exchanging" | "approved" | "consumed" | "cancelled";
export interface TxCtx { country: string; city: string; ua: string }
interface Tx {
  app: AppId; access: Access;
  claimHash: string; code: string; attempts: number; ctx: TxCtx;
  state: string; verifier: string; challenge: string;
  status: Status; nonce?: string;
  token?: string; tokenLifeMs?: number; scope?: string; // token is sealed (AES-GCM)
  created: number; exp: number;
}
interface Sess {
  v: 2; app: AppId; access: Access;
  token: string; // sealed
  scope: string; created: number; last: number; hardExp: number; sends: number;
}

const clip = (s: unknown, n: number) => String(s ?? "").replace(/[\r\n\0]/g, " ").slice(0, n);

export class StoreCore {
  private rl = new Map<string, { n: number; reset: number }>(); // in memory only: no storage write per request

  constructor(private kv: KV, private hooks: Hooks) {}

  private now() { return this.hooks.now ? this.hooks.now() : Date.now(); }
  private async sched() { if (!(await this.kv.getAlarm())) await this.kv.setAlarm(Date.now() + 30_000); }
  private save(id: string, t: Tx) { return this.kv.put("t:" + id, t); }
  private secretOk = async (t: Tx, secret: string) => !!secret && timingSafeEqual(await sha(secret), t.claimHash);

  private async tx(id: string) {
    const t = await this.kv.get<Tx>("t:" + id);
    if (!t) return null;
    if (t.exp < this.now() || !t.claimHash) { await this.kv.delete("t:" + id); return null; } // also drops v1-format records
    return t;
  }

  // ---------------- link transactions ----------------
  async newTx(app: unknown, access: unknown, claimHash: unknown, ctx: Partial<TxCtx>) {
    if (!isApp(app) || !isAccess(access) || !scopesFor(app, access)) return { error: "bad_request" as const };
    if (typeof claimHash !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(claimHash)) return { error: "bad_request" as const };
    if ((await this.kv.list({ prefix: "t:" })).size >= MAX_PENDING) return { error: "busy" as const };
    const id = rnd(16), verifier = rnd(32), now = this.now();
    const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, "0");
    const t: Tx = {
      app, access, claimHash, code, attempts: 0,
      ctx: { country: clip(ctx.country, 4), city: clip(ctx.city, 60), ua: clip(ctx.ua, 60) },
      state: id + "." + rnd(16), verifier, challenge: await sha(verifier),
      status: "pending", created: now, exp: now + TX_TTL,
    };
    await this.save(id, t); await this.sched();
    return { id, code, ttlMs: TX_TTL };
  }

  /** Polled by the shared computer. Needs the claim secret; anyone else just sees "expired". */
  async status(id: string, secret: string): Promise<Status | "expired"> {
    const t = await this.tx(id);
    if (!t || !(await this.secretOk(t, secret))) return "expired";
    return t.status === "confirmed" || t.status === "authorizing" || t.status === "exchanging" ? "pending" : t.status;
  }

  /** Shown on the phone. Deliberately does NOT include the verification code. */
  async info(id: string) {
    const t = await this.tx(id);
    if (!t || t.status !== "pending") return null;
    const a = APPS[t.app];
    return {
      app: t.app, access: t.access, vendor: a.vendor as VendorId, label: t.access === "stream" ? a.label + " web player" : a.label,
      describe: a.describe[t.access] ?? "", ctx: t.ctx,
      ageSec: Math.floor((this.now() - t.created) / 1000), ttlMs: t.exp - this.now(),
    };
  }

  /** Phone: user typed the code shown on the computer. */
  async confirm(id: string, code: unknown) {
    const t = await this.tx(id);
    if (!t || t.status !== "pending") return { error: "expired" as const };
    t.attempts += 1;
    const ok = typeof code === "string" && /^\d{6}$/.test(code) && timingSafeEqual(code, t.code);
    if (!ok) {
      if (t.attempts >= CODE_TRIES) t.status = "cancelled";
      await this.save(id, t);
      return t.status === "cancelled" ? { error: "locked" as const } : { error: "wrong_code" as const, left: CODE_TRIES - t.attempts };
    }
    t.status = "confirmed"; t.nonce = rnd(16);
    await this.save(id, t);
    return { nonce: t.nonce };
  }

  async begin(id: string, nonce: string) {
    const t = await this.tx(id);
    if (!t || t.status !== "confirmed" || !t.nonce || !timingSafeEqual(t.nonce, nonce)) return null;
    t.status = "authorizing"; delete t.nonce; await this.save(id, t);
    return { state: t.state, challenge: t.challenge, app: t.app, access: t.access, vendor: APPS[t.app].vendor as VendorId };
  }

  async takeState(state: string) {
    if (!/^[\w-]+\.[\w-]+$/.test(state)) return null;
    const id = state.split(".")[0];
    const t = await this.tx(id);
    if (!t || t.status !== "authorizing" || !timingSafeEqual(t.state, state)) return null;
    t.status = "exchanging"; await this.save(id, t);
    return { id, verifier: t.verifier, app: t.app, access: t.access, vendor: APPS[t.app].vendor as VendorId };
  }

  /** Callback succeeded. Verifies that the vendor granted every scope we asked for (users can untick scopes). */
  async approve(id: string, r: { token: string; tokenLifeMs: number; scope: string }): Promise<"ok" | "scope" | "state"> {
    const t = await this.tx(id);
    if (!t || t.status !== "exchanging") return "state";
    const granted = scopeList(r.scope);
    if (!scopeList(scopesFor(t.app, t.access)).every((s) => granted.includes(s))) {
      t.status = "cancelled"; await this.save(id, t);
      this.hooks.revoke(t.app, r.token); // do not keep a token that does less than requested
      return "scope";
    }
    t.token = await this.hooks.seal(r.token, "t:" + id);
    t.tokenLifeMs = r.tokenLifeMs; t.scope = r.scope; t.status = "approved";
    await this.save(id, t);
    return "ok";
  }

  async fail(id: string) {
    const t = await this.tx(id);
    if (t) { t.status = "cancelled"; delete t.token; await this.save(id, t); }
  }

  /** `secret` given (from the computer) must match. No secret = phone-side decline. */
  async cancel(id: string, secret?: string) {
    const t = await this.tx(id);
    if (!t || !["pending", "confirmed", "authorizing"].includes(t.status)) return;
    if (secret !== undefined && !(await this.secretOk(t, secret))) return;
    t.status = "cancelled"; await this.save(id, t);
  }

  /** One-time. Needs the claim secret held only by the shared browser. */
  async claim(id: string, secret: string) {
    const t = await this.tx(id);
    if (!t || t.access === "stream" || t.status !== "approved" || !t.token || !(await this.secretOk(t, secret))) return null;
    const plain = await this.hooks.open(t.token, "t:" + id);
    const cap = rnd(32), now = this.now(), k = "s:" + (await sha(cap));
    const life = Math.max(30_000, Math.min(APPS[t.app].maxLifeMs, (t.tokenLifeMs ?? 3_600_000) - 60_000));
    const s: Sess = {
      v: 2, app: t.app, access: t.access, token: await this.hooks.seal(plain, k),
      scope: t.scope ?? "", created: now, last: now, hardExp: now + life, sends: 0,
    };
    await this.kv.put(k, s);
    t.status = "consumed"; delete t.token; await this.save(id, t);
    await this.sched();
    return { cap, ttlMs: life, app: t.app, access: t.access };
  }

  /**
   * Web player (access "stream"): the token is handed over ONCE, to the holder of the claim secret, and the Relay keeps
   * nothing: no session, no capability, no copy of the token, no refresh token, no account information.
   */
  async claimToken(id: string, secret: string) {
    const t = await this.tx(id);
    if (!t || t.access !== "stream" || t.status !== "approved" || !t.token || !(await this.secretOk(t, secret))) return null;
    const token = await this.hooks.open(t.token, "t:" + id);
    const ttlMs = Math.max(30_000, (t.tokenLifeMs ?? 3_600_000) - 60_000);
    t.status = "consumed"; delete t.token; await this.save(id, t);
    return { token, ttlMs, app: t.app, access: t.access };
  }

  // ---------------- sessions ----------------
  private expired(s: Sess, now: number) { return now > s.hardExp || now - s.last > APPS[s.app].idleMs; }

  /** `touch=false` for background polling so the idle timer only measures human activity. */
  async auth(cap: string, app: AppId, touch = true) {
    const k = "s:" + (await sha(cap));
    const s = await this.kv.get<Sess>(k);
    if (!s || s.v !== 2 || s.app !== app) return null; // wrong app looks exactly like "expired"
    const now = this.now();
    if (this.expired(s, now)) { await this.dispose(k, s); return null; }
    if (touch) { s.last = now; await this.kv.put(k, s); }
    return { token: await this.hooks.open(s.token, k), access: s.access, ttlMs: s.hardExp - now };
  }

  async revoke(cap: string) {
    const k = "s:" + (await sha(cap));
    const s = await this.kv.get<Sess>(k);
    if (s) await this.dispose(k, s);
  }

  private async dispose(k: string, s: Sess) {
    await this.kv.delete(k);
    if (s.v !== 2) return;
    try { this.hooks.revoke(s.app, await this.hooks.open(s.token, k)); } catch { /* best effort */ }
  }

  /** Reserve one of the session's Gmail sends. Counted before sending, so failed attempts cannot be retried forever. */
  async sendSlot(cap: string) {
    const k = "s:" + (await sha(cap));
    const s = await this.kv.get<Sess>(k);
    const now = this.now();
    if (!s || s.v !== 2 || s.app !== "gmail" || s.access !== "write" || this.expired(s, now)) return { ok: false as const, reason: "session_expired" as const };
    if (s.sends >= MAX_SENDS) return { ok: false as const, reason: "send_limit" as const };
    s.sends += 1; s.last = now; await this.kv.put(k, s);
    return { ok: true as const, left: MAX_SENDS - s.sends };
  }

  // ---------------- rate limiting (in memory) ----------------
  hit(key: string, limit: number, windowMs: number): boolean {
    const now = this.now();
    let r = this.rl.get(key);
    if (!r || r.reset < now) {
      r = { n: 0, reset: now + windowMs }; this.rl.set(key, r);
      if (this.rl.size > 5000) for (const [k, v] of this.rl) if (v.reset < now) this.rl.delete(k);
    }
    r.n += 1;
    return r.n <= limit;
  }

  // ---------------- cleanup ----------------
  async alarm() {
    const now = this.now(); let left = 0;
    for (const [k, v] of await this.kv.list<any>()) {
      if (k.startsWith("t:")) {
        if (v.exp < now || !v.claimHash) await this.kv.delete(k); else left++;
      } else if (k.startsWith("s:")) {
        if (v.v !== 2) await this.kv.delete(k); // v1 sessions: drop
        else if (this.expired(v, now)) await this.dispose(k, v); // deletes + revokes at vendor
        else left++;
      } else await this.kv.delete(k); // stale v1 rate-limit keys etc.
    }
    if (left) await this.kv.setAlarm(Date.now() + 30_000);
  }
}
