import type { Store } from "./store";

export interface Env {
  STORE: DurableObjectNamespace<Store>;
  FRONTEND_ORIGIN: string;
  FRONTEND_URL: string;
  /** 32 random bytes, base64. Encrypts provider tokens at rest inside the Durable Object. */
  TOKEN_KEY: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GOOGLE_REDIRECT_URI: string;
  /** Spotify is optional: leave the three values empty and the Spotify tile reports "not configured". */
  SPOTIFY_CLIENT_ID?: string;
  SPOTIFY_CLIENT_SECRET?: string;
  SPOTIFY_REDIRECT_URI?: string;
}
