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
  /** Outlook (v3) is optional: leave these empty and the Outlook tile reports "not configured". The secret is a Cloudflare secret. */
  MICROSOFT_CLIENT_ID?: string;
  MICROSOFT_CLIENT_SECRET?: string;
  MICROSOFT_REDIRECT_URI?: string;
  /** "consumers" (personal accounts, the default), "organizations", "common" or a tenant GUID. Anything else = not configured. */
  MICROSOFT_TENANT?: string;
  /**
   * Notion (v4) is optional. TWO integrations (public connections) so that Notion itself enforces read-only:
   * "read" uses NOTION_READ_* (capability: read content only), "write" uses NOTION_WRITE_*. Both use the same redirect URI.
   */
  NOTION_READ_CLIENT_ID?: string;
  NOTION_READ_CLIENT_SECRET?: string;
  NOTION_WRITE_CLIENT_ID?: string;
  NOTION_WRITE_CLIENT_SECRET?: string;
  NOTION_REDIRECT_URI?: string;
  /** Spotify web player (v2.1). A DIFFERENT origin than FRONTEND_ORIGIN, e.g. https://sakkol-player.github.io (no path). */
  PLAYER_ORIGIN?: string;
  /** Full URL of the player page, with trailing slash, e.g. https://sakkol-player.github.io/player/ */
  PLAYER_URL?: string;
}
