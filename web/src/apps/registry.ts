import type { AppId } from "../core/state";
import { mountGmail } from "./gmail";
import { mountOutlook } from "./outlook";
import { mountSpotify } from "./spotify";
import { mountTasks } from "./tasks";
import { mountNotion } from "./notion";

export interface Tile {
  id: string; name: string; icon: string; blurb: string;
  status: "available" | "soon";
}

// Adding an app = one line here + one folder under apps/ + one entry in worker/src/apps.ts.
export const TILES: Tile[] = [
  { id: "gmail", name: "Gmail", icon: "✉️", blurb: "Read and write email", status: "available" },
  { id: "outlook", name: "Outlook", icon: "📧", blurb: "Read and write Outlook / Hotmail email", status: "available" },
  { id: "tasks", name: "Google Tasks", icon: "✅", blurb: "See, add and complete your tasks", status: "available" },
  { id: "spotify", name: "Spotify", icon: "🎵", blurb: "Play music on your devices", status: "available" },
  { id: "drive", name: "Google Drive", icon: "📁", blurb: "Files", status: "soon" },
  { id: "notion", name: "Notion", icon: "📝", blurb: "Search, read and add to your notes", status: "available" },
];

export const MOUNT: Record<AppId, (root: HTMLElement) => void> = { gmail: mountGmail, outlook: mountOutlook, tasks: mountTasks, notion: mountNotion, spotify: mountSpotify };
