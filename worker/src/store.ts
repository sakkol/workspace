import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import { APPS, AppId } from "./apps";
import { StoreCore, KV, TxCtx } from "./core";
import { makeSealer } from "./security";
import { VENDORS } from "./vendors";

// Thin Durable Object wrapper around StoreCore. KEEP THE CLASS NAME `Store`: renaming it needs a migration.
export class Store extends DurableObject<Env> {
  private core: StoreCore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const sealer = env.TOKEN_KEY ? makeSealer(env.TOKEN_KEY) : null;
    const need = () => { if (!sealer) throw new Error("config_error: TOKEN_KEY missing"); return sealer; };
    this.core = new StoreCore(ctx.storage as unknown as KV, {
      seal: async (p, aad) => (await need()).seal(p, aad),
      open: async (s, aad) => (await need()).open(s, aad),
      revoke: (app: AppId, token: string) => {
        const rev = VENDORS[APPS[app].vendor].revoke;
        if (rev) ctx.waitUntil(rev(token).catch(() => {}));
      },
    });
  }

  newTx(app: unknown, access: unknown, claimHash: unknown, ctx: Partial<TxCtx>) { return this.core.newTx(app, access, claimHash, ctx); }
  status(id: string, secret: string) { return this.core.status(id, secret); }
  info(id: string) { return this.core.info(id); }
  confirm(id: string, code: unknown) { return this.core.confirm(id, code); }
  begin(id: string, nonce: string) { return this.core.begin(id, nonce); }
  takeState(state: string) { return this.core.takeState(state); }
  approve(id: string, r: { token: string; tokenLifeMs: number; scope: string }) { return this.core.approve(id, r); }
  fail(id: string) { return this.core.fail(id); }
  cancel(id: string, secret?: string) { return this.core.cancel(id, secret); }
  claim(id: string, secret: string) { return this.core.claim(id, secret); }
  auth(cap: string, app: AppId, touch = true) { return this.core.auth(cap, app, touch); }
  revoke(cap: string) { return this.core.revoke(cap); }
  sendSlot(cap: string) { return this.core.sendSlot(cap); }
  async hit(key: string, limit: number, windowMs: number) { return this.core.hit(key, limit, windowMs); }
  alarm() { return this.core.alarm(); }
}
