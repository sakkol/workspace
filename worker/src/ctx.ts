import type { Env } from "./env";
import type { Store } from "./store";

export interface RouteCtx {
  env: Env;
  req: Request;
  u: URL;
  p: string;
  store: DurableObjectStub<Store>;
  bearer: string | null;
  J: (body: unknown, status?: number, headers?: Record<string, string>) => Response;
  lim: (bucket: string, n: number) => Promise<boolean>;
  json: () => Promise<Record<string, unknown>>;
}
