import type { AppId } from "../core/state";
import { mountGmail } from "./gmail";
import { mountSpotify } from "./spotify";

export interface Tile {
  id: string; name: string; icon: string; blurb: string;
  status: "available" | "soon";
}

// Adding an app = one line here + one folder under apps/ + one entry in worker/src/apps.ts.
export const TILES: Tile[] = [
  { id: "gmail", name: "Gmail", icon: "✉️", blurb: "Read and write email", status: "available" },
  { id: "spotify", name: "Spotify", icon: "🎵", blurb: "Play music on your devices", status: "available" },
  { id: "drive", name: "Google Drive", icon: "📁", blurb: "Files", status: "soon" },
  { id: "notion", name: "Notion", icon: "📝", blurb: "Notes and docs", status: "soon" },
];

export const MOUNT: Record<AppId, (root: HTMLElement) => void> = { gmail: mountGmail, spotify: mountSpotify };
