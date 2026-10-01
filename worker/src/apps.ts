// One entry per unlockable app. To add an app (Drive, Notion...), add it here, add a vendor in
// vendors.ts if needed, add a route file, and add a tile in the frontend registry.

export type AppId = "gmail" | "spotify" | "outlook" | "tasks" | "notion";
// "stream" = Spotify Web Playback SDK in the isolated player site: the browser receives a short-lived token ONCE at claim
// (no Relay session, no capability). Only the player origin may start/claim it.
export type Access = "read" | "write" | "stream";
export type VendorId = "google" | "spotify" | "microsoft" | "notion";

export interface AppDef {
  id: AppId;
  vendor: VendorId;
  label: string;
  scopes: Partial<Record<Access, string>>; // space-separated
  /**
   * The vendor has NO scope parameter (Notion): what an app may do is configured on the vendor side (per integration).
   * Scope verification is skipped ONLY for such apps; it stays mandatory whenever scopes exist (R8).
   */
  noScopes?: boolean;
  describe: Partial<Record<Access, string>>; // shown on the phone before approval
  maxLifeMs: number; // absolute session lifetime
  idleMs: number; // idle timeout (human activity only)
}

export const APPS: Record<AppId, AppDef> = {
  gmail: {
    id: "gmail",
    vendor: "google",
    label: "Gmail",
    scopes: {
      read: "https://www.googleapis.com/auth/gmail.readonly",
      // gmail.modify = read, send, labels, trash. NOT permanent delete. No settings access (no auto-forward rules).
      write: "https://www.googleapis.com/auth/gmail.modify",
    },
    describe: {
      read: "Read your email. Nothing can be sent or changed.",
      write: "Read, send, star, archive and trash email. Cannot permanently delete mail or change settings.",
    },
    maxLifeMs: 30 * 60_000,
    idleMs: 5 * 60_000,
  },
  spotify: {
    id: "spotify",
    vendor: "spotify",
    label: "Spotify",
    scopes: {
      write: "user-read-playback-state user-read-currently-playing user-modify-playback-state",
      // The Web Playback SDK requires streaming + user-read-email + user-read-private.
      // Library browsing also needs the read scopes below because the player uses the same
      // short-lived Spotify token to read the user's saved albums and playlists.
      stream: "streaming user-read-email user-read-private user-read-playback-state user-modify-playback-state user-library-read playlist-read-private playlist-read-collaborative",
    },
    describe: {
      write: "See what is playing and control playback on your Spotify devices. Cannot see your email or payment details.",
      stream: "Play music in a browser tab (Spotify web player), search tracks, and browse your saved albums and playlists. That tab receives a Spotify access token valid for about an hour that cannot be revoked early, and it can read your Spotify email address, country, saved albums, and playlists.",
    },
    maxLifeMs: 45 * 60_000, // Spotify access tokens last ~60 min
    idleMs: 15 * 60_000,
  },
  outlook: {
    id: "outlook",
    vendor: "microsoft",
    label: "Outlook",
    scopes: {
      read: "https://graph.microsoft.com/Mail.Read",
      // Mail.ReadWrite = read, flag, move. Mail.Send = send/reply. NEVER: offline_access, MailboxSettings.*, Mail.*.Shared, Contacts, Calendars.
      write: "https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Send",
    },
    describe: {
      read: "Read your Outlook email. Nothing can be sent or changed.",
      write: "Read, send, reply, flag, archive and move Outlook email to Deleted Items. Cannot permanently delete mail or change settings, rules or forwarding.",
    },
    maxLifeMs: 30 * 60_000,
    idleMs: 5 * 60_000,
  },
  tasks: {
    id: "tasks",
    vendor: "google",
    label: "Google Tasks",
    scopes: {
      read: "https://www.googleapis.com/auth/tasks.readonly",
      // tasks = read + create + edit + complete. The Relay exposes NO delete route (R14); the scope itself would allow it.
      write: "https://www.googleapis.com/auth/tasks",
    },
    describe: {
      read: "See your Google Tasks lists and tasks. Nothing can be changed.",
      write: "See, add, edit and complete your Google Tasks. Cannot delete tasks or lists.",
    },
    maxLifeMs: 30 * 60_000,
    idleMs: 5 * 60_000,
  },
  notion: {
    id: "notion",
    vendor: "notion",
    label: "Notion",
    scopes: {},
    noScopes: true,
    // Two separate Notion integrations: "read" uses one that only has the "read content" capability, so Notion itself refuses writes.
    describe: {
      read: "Search and read the Notion pages you choose to share on the next screen. Nothing can be changed.",
      write: "Search and read the Notion pages you choose to share, create new pages under them and add text to them. Cannot edit existing text, delete or move anything.",
    },
    maxLifeMs: 30 * 60_000,
    idleMs: 5 * 60_000,
  },
};

export const isApp = (x: unknown): x is AppId => typeof x === "string" && Object.hasOwn(APPS, x);
export const isAccess = (x: unknown): x is Access => x === "read" || x === "write" || x === "stream";
export const scopesFor = (app: AppId, access: Access) => APPS[app].scopes[access] ?? "";
/** Can this app be unlocked at this access level? (noScopes apps have no scope string, so they are defined by `describe`.) */
export const hasAccess = (app: AppId, access: Access) => (APPS[app].noScopes ? APPS[app].describe[access] !== undefined : !!scopesFor(app, access));
export const scopeList = (s: string) => s.split(/[ ,]+/).filter(Boolean);

/**
 * Scope comparison is vendor-specific. Microsoft may return scopes in another case, with or without the
 * "https://graph.microsoft.com/" prefix, and may add default scopes (User.Read, profile, openid, email) that we never asked for.
 */
export const normalizeScope = (vendor: VendorId, s: string) =>
  vendor === "microsoft" ? s.trim().toLowerCase().replace(/^https:\/\/graph\.microsoft\.com\//, "") : s;

/** True only if EVERY requested scope was granted. Extra granted scopes are tolerated and never used (R8). */
export const scopesGranted = (vendor: VendorId, requested: string, granted: string) => {
  const g = new Set(scopeList(granted).map((x) => normalizeScope(vendor, x)));
  return scopeList(requested).every((x) => g.has(normalizeScope(vendor, x)));
};

// ---------------- Google bundle (one sign-in, several Google apps) ----------------
export interface BundleItem { app: AppId; access: Access }
/** Hard limit on apps per bundle. */
export const BUNDLE_MAX = 3;
/**
 * A bundle is only ever made of apps of the SAME vendor, and only of the vendor "google" (Outlook, Spotify and the
 * player always unlock on their own). Returns the validated list, or null if anything is off.
 */
export function makeBundle(primary: BundleItem, also: unknown): BundleItem[] | null {
  if (also === undefined || also === null) return [primary];
  if (!Array.isArray(also) || also.length < 1 || also.length + 1 > BUNDLE_MAX) return null;
  const list: BundleItem[] = [primary];
  for (const x of also) {
    if (!x || typeof x !== "object" || Array.isArray(x)) return null;
    const { app, access } = x as Record<string, unknown>;
    if (!isApp(app) || !isAccess(access)) return null;
    list.push({ app, access: access as Access });
  }
  const seen = new Set<string>();
  for (const i of list) {
    if (seen.has(i.app)) return null; // one entry per app
    seen.add(i.app);
    if (i.access === "stream" || !hasAccess(i.app, i.access)) return null;
    if (APPS[i.app].vendor !== "google") return null; // bundles: Google only (R7)
  }
  return list;
}
/** Union of the scopes of every app in the bundle, in a stable order. */
export const bundleScopes = (list: BundleItem[]) => [...new Set(list.flatMap((i) => scopeList(scopesFor(i.app, i.access))))].join(" ");
