import type { RouteCtx } from "./ctx";
import { HttpErr, Bad } from "./errors";

const URI = /^spotify:(track|album|playlist|artist):[A-Za-z0-9]{22}$/;
const DEV = /^[\w-]{1,80}$/;
const ART = "https://i.scdn.co/";

async function spot(token: string, method: string, path: string, body?: unknown) {
  const r = await fetch("https://api.spotify.com/v1" + path, {
    method,
    headers: { Authorization: "Bearer " + token, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 204) return null;
  if (r.status === 401) throw new HttpErr(401, "session_expired");
  if (r.status === 429) throw new HttpErr(429, "spotify_rate_limited", r.headers.get("Retry-After"));
  if (r.status === 403) {
    const j: any = await r.json().catch(() => ({}));
    throw new HttpErr(403, j?.error?.reason === "PREMIUM_REQUIRED" ? "premium_required" : "spotify_forbidden");
  }
  if (r.status === 404) throw new HttpErr(404, "no_active_device");
  if (!r.ok) throw new HttpErr(502, "spotify_unavailable");
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

const art = (images: any[] | undefined) => {
  const u = (images?.[1] ?? images?.[0])?.url;
  return typeof u === "string" && u.startsWith(ART) ? u : ""; // only Spotify's image CDN (the CSP allows only that)
};

// Return only what the UI needs, never Spotify's raw response.
function shapePlayer(d: any) {
  if (!d) return { active: false };
  const it = d.item;
  return {
    active: true, playing: !!d.is_playing, progressMs: d.progress_ms ?? 0, durationMs: it?.duration_ms ?? 0,
    title: it?.name ?? "", artist: (it?.artists ?? []).map((a: any) => a.name).join(", "),
    album: it?.album?.name ?? "", art: art(it?.album?.images),
    volume: d.device?.volume_percent ?? null, device: d.device ? { id: d.device.id ?? "", name: d.device.name ?? "" } : null,
  };
}

const qDevice = (id: unknown) => {
  if (id === undefined || id === null || id === "") return "";
  if (typeof id !== "string" || !DEV.test(id)) throw new Bad("bad_device");
  return "device_id=" + encodeURIComponent(id);
};

export async function handleSpotify(c: RouteCtx): Promise<Response> {
  const { p, req, u, J, store, bearer } = c;
  if (!(await c.lim("spotify", 120))) return J({ error: "rate_limited" }, 429);
  // Only GET /spotify/player is "passive" (background poll): it must not keep an idle session alive.
  const passive = p === "/spotify/player" && req.method === "GET";
  const s = bearer ? await store.auth(bearer, "spotify", !passive) : null;
  if (!s) return J({ error: "session_expired" }, 401);
  const t = s.token;

  if (p === "/spotify/player" && req.method === "GET") return J(shapePlayer(await spot(t, "GET", "/me/player")));

  if (p === "/spotify/devices" && req.method === "GET") {
    const d = await spot(t, "GET", "/me/player/devices");
    return J({ devices: (d?.devices ?? []).filter((x: any) => x.id).map((x: any) => ({ id: x.id, name: x.name, type: x.type, active: !!x.is_active })) });
  }

  if (p === "/spotify/search" && req.method === "GET") {
    const q = (u.searchParams.get("q") || "").trim();
    if (!q || q.length > 100) throw new Bad("bad_query");
    const d = await spot(t, "GET", "/search?" + new URLSearchParams({ q, type: "track", limit: "10" }));
    return J({
      tracks: (d?.tracks?.items ?? []).map((x: any) => ({
        uri: x.uri, title: x.name, artist: (x.artists ?? []).map((a: any) => a.name).join(", "),
        album: x.album?.name ?? "", art: art(x.album?.images), durationMs: x.duration_ms ?? 0,
      })).filter((x: any) => URI.test(x.uri)),
    });
  }

  if (req.method === "POST") {
    if (!(await c.lim("spotify-cmd", 60))) return J({ error: "rate_limited" }, 429);
    const needBody = p === "/spotify/play" || p === "/spotify/volume" || p === "/spotify/transfer";
    const b = needBody ? await c.json() : {};
    switch (p) {
      case "/spotify/play": {
        const body: Record<string, unknown> = {};
        if (b.uri !== undefined) { if (typeof b.uri !== "string" || !/^spotify:track:[A-Za-z0-9]{22}$/.test(b.uri)) throw new Bad("bad_uri"); body.uris = [b.uri]; }
        else if (b.contextUri !== undefined) { if (typeof b.contextUri !== "string" || !URI.test(b.contextUri) || b.contextUri.startsWith("spotify:track:")) throw new Bad("bad_uri"); body.context_uri = b.contextUri; }
        const dq = qDevice(b.deviceId);
        await spot(t, "PUT", "/me/player/play" + (dq ? "?" + dq : ""), Object.keys(body).length ? body : undefined);
        return J({ ok: true });
      }
      case "/spotify/pause": await spot(t, "PUT", "/me/player/pause"); return J({ ok: true });
      case "/spotify/next": await spot(t, "POST", "/me/player/next"); return J({ ok: true });
      case "/spotify/previous": await spot(t, "POST", "/me/player/previous"); return J({ ok: true });
      case "/spotify/volume": {
        const v = b.percent;
        if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 100) throw new Bad("bad_volume");
        await spot(t, "PUT", "/me/player/volume?volume_percent=" + v);
        return J({ ok: true });
      }
      case "/spotify/transfer": {
        if (typeof b.deviceId !== "string" || !DEV.test(b.deviceId)) throw new Bad("bad_device");
        await spot(t, "PUT", "/me/player", { device_ids: [b.deviceId], play: b.play === true });
        return J({ ok: true });
      }
    }
  }
  return J({ error: "not_found" }, 404);
}
