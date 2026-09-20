// One entry per unlockable app. To add an app (Drive, Notion...), add it here, add a vendor in
// vendors.ts if needed, add a route file, and add a tile in the frontend registry.

export type AppId = "gmail" | "spotify";
export type Access = "read" | "write";
export type VendorId = "google" | "spotify";

export interface AppDef {
  id: AppId;
  vendor: VendorId;
  label: string;
  scopes: Partial<Record<Access, string>>; // space-separated
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
    },
    describe: {
      write: "See what is playing and control playback on your Spotify devices. Cannot see your email or payment details.",
    },
    maxLifeMs: 45 * 60_000, // Spotify access tokens last ~60 min
    idleMs: 15 * 60_000,
  },
};

export const isApp = (x: unknown): x is AppId => typeof x === "string" && Object.hasOwn(APPS, x);
export const isAccess = (x: unknown): x is Access => x === "read" || x === "write";
export const scopesFor = (app: AppId, access: Access) => APPS[app].scopes[access] ?? "";
export const scopeList = (s: string) => s.split(/[ ,]+/).filter(Boolean);
