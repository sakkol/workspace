import { KV, Hooks, StoreCore } from "../src/core";
import { b64u, sha } from "../src/security";
import type { AppId, Access } from "../src/apps";

export class FakeKV implements KV {
  m = new Map<string, unknown>();
  alarm: number | null = null;
  async get<T>(k: string) { const v = this.m.get(k); return v === undefined ? undefined : (structuredClone(v) as T); }
  async put(k: string, v: unknown) { this.m.set(k, structuredClone(v)); }
  async delete(k: string) { return this.m.delete(k); }
  async list<T>(o?: { prefix?: string }) {
    return new Map([...this.m].filter(([k]) => !o?.prefix || k.startsWith(o.prefix)).map(([k, v]) => [k, structuredClone(v) as T]));
  }
  async getAlarm() { return this.alarm; }
  async setAlarm(t: number) { this.alarm = t; }
}

export function setup() {
  const kv = new FakeKV();
  const clock = { t: 1_000_000 };
  const revoked: Array<{ app: AppId; token: string }> = [];
  const hooks: Hooks = {
    // "sealing" for tests: reversible and visibly different from the plaintext
    seal: async (p, aad) => "sealed:" + aad + ":" + p,
    open: async (s, aad) => {
      const pre = "sealed:" + aad + ":";
      if (!s.startsWith(pre)) throw new Error("aad mismatch");
      return s.slice(pre.length);
    },
    revoke: (app, token) => { revoked.push({ app, token }); },
    now: () => clock.t,
  };
  return { kv, clock, revoked, core: new StoreCore(kv, hooks) };
}

export const CTX = { country: "DE", city: "Berlin", ua: "Chrome on Windows" };
export const newSecret = async () => {
  const secret = b64u(crypto.getRandomValues(new Uint8Array(32)));
  return { secret, hash: await sha(secret) };
};

/** Drive a transaction all the way to `approved`. */
export async function approvedTx(s: ReturnType<typeof setup>, app: AppId = "gmail", access: Access = "read", scope?: string) {
  const { secret, hash } = await newSecret();
  const tx: any = await s.core.newTx(app, access, hash, CTX);
  const conf: any = await s.core.confirm(tx.id, tx.code);
  const b: any = await s.core.begin(tx.id, conf.nonce);
  const st: any = await s.core.takeState(b.state);
  const granted = scope ?? (app === "gmail"
    ? (access === "write" ? "https://www.googleapis.com/auth/gmail.modify" : "https://www.googleapis.com/auth/gmail.readonly")
    : "user-read-playback-state user-read-currently-playing user-modify-playback-state");
  const res = await s.core.approve(st.id, { token: "TOKEN-" + app, tokenLifeMs: 3_600_000, scope: granted });
  return { tx, secret, res, id: tx.id as string };
}
