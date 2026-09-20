import { h, mmss } from "../../core/dom";
import { api, post, lockApp, errText, ApiError } from "../../core/api";
import { caps, every, go, registerWiper } from "../../core/state";

interface Player { active: boolean; playing?: boolean; progressMs?: number; durationMs?: number; title?: string; artist?: string; album?: string; art?: string; volume?: number | null; device?: { id: string; name: string } | null }
interface Track { uri: string; title: string; artist: string; album: string; art: string; durationMs: number }
interface Dev { id: string; name: string; type: string; active: boolean }

// In-memory only; wiped on lock.
const S = { player: { active: false } as Player, devices: [] as Dev[], tracks: [] as Track[], q: "", pendingUri: "", t0: 0 };
const wipe = () => { S.player = { active: false }; S.devices = []; S.tracks = []; S.q = ""; S.pendingUri = ""; };
registerWiper("spotify", wipe);

const fmt = (ms: number) => mmss(ms);
const artOk = (u?: string) => !!u && u.startsWith("https://i.scdn.co/"); // matches the CSP img-src

export function mountSpotify(root: HTMLElement) {
  const cap = caps.get("spotify")!;
  const cd = h("span");
  const tick = () => { cd.textContent = mmss(cap.expAt - Date.now()); };
  tick(); every(tick, 1000);

  const msg = h("p", { cls: "err", role: "alert" });
  const nowEl = h("div", { cls: "np" });
  const devEl = h("div", { cls: "devs" });
  const results = h("div", { cls: "results" });
  const search = h("input", { type: "search", placeholder: "Search songs…", "aria-label": "Search songs", autocomplete: "off", maxlength: "100" });

  root.replaceChildren(
    h("div", { cls: "bar" },
      h("div", {}, h("strong", {}, "🎵 Spotify"), h("div", { cls: "mut small" }, "Session ends in ", cd)),
      h("div", { cls: "row-r" }, h("button", { onclick: () => go({ n: "launcher" }) }, "Apps"),
        h("button", { cls: "done", onclick: async () => { await lockApp("spotify"); go({ n: "launcher" }); } }, "DONE — lock Spotify"))),
    h("p", { cls: "mut small" }, "Music plays on your own Spotify device (phone, speaker). This page is the remote control."),
    msg, nowEl, devEl, search, results);

  const fail = (e: unknown) => {
    if (e instanceof ApiError && e.status === 401) return;
    msg.textContent = errText(e);
    if (e instanceof ApiError && e.code === "no_active_device") void loadDevices();
  };

  // ---- player ----
  function drawPlayer() {
    const p = S.player;
    if (!p.active) {
      nowEl.replaceChildren(h("div", { cls: "mut" }, "Nothing is playing."),
        h("div", { cls: "row-l" }, h("button", { onclick: () => void poll() }, "Refresh"), h("button", { onclick: () => void loadDevices() }, "Choose device")));
      return;
    }
    const prog = h("div", { cls: "prog" }, h("div", { cls: "progfill" }));
    const time = h("span", { cls: "mut small" });
    const vol = h("input", { type: "range", min: "0", max: "100", value: p.volume ?? 50, "aria-label": "Volume", disabled: p.volume == null });
    let vt = 0;
    vol.oninput = () => { clearTimeout(vt); vt = window.setTimeout(() => cmd("/spotify/volume", { percent: Number((vol as HTMLInputElement).value) }), 300); };
    nowEl.replaceChildren(h("div", { cls: "npmain" },
      artOk(p.art) ? h("img", { src: p.art, alt: "", width: "96", height: "96", referrerpolicy: "no-referrer" }) : h("div", { cls: "noart" }, "♪"),
      h("div", { cls: "npinfo" }, h("strong", {}, p.title || "Unknown"), h("div", { cls: "mut" }, [p.artist, p.album].filter(Boolean).join(" · ")),
        prog, time,
        h("div", { cls: "row-l" },
          h("button", { onclick: () => cmd("/spotify/previous"), "aria-label": "Previous" }, "⏮"),
          h("button", { cls: "pri", onclick: () => cmd(p.playing ? "/spotify/pause" : "/spotify/play", p.playing ? undefined : {}), "aria-label": p.playing ? "Pause" : "Play" }, p.playing ? "⏸" : "▶"),
          h("button", { onclick: () => cmd("/spotify/next"), "aria-label": "Next" }, "⏭")),
        h("label", { cls: "small" }, "Volume ", vol),
        h("div", { cls: "mut small" }, "On: " + (p.device?.name || "unknown device")))));
    const upd = () => {
      const el = S.player; if (!el.active) return;
      const pos = Math.min(el.durationMs || 0, (el.progressMs || 0) + (el.playing ? Date.now() - S.t0 : 0));
      (prog.firstChild as HTMLElement).style.width = (el.durationMs ? (pos / el.durationMs) * 100 : 0) + "%"; // CSSOM, allowed by CSP
      time.textContent = `${fmt(pos)} / ${fmt(el.durationMs || 0)}`;
    };
    upd(); progTimer = upd;
  }
  let progTimer: () => void = () => {};
  every(() => progTimer(), 1000);

  async function poll() {
    if (document.visibilityState !== "visible") return;
    try {
      S.player = await api("spotify", "/spotify/player"); S.t0 = Date.now(); msg.textContent = "";
      if (caps.has("spotify")) drawPlayer();
    } catch (e) { fail(e); }
  }
  every(() => void poll(), 5000);
  void poll();
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && caps.has("spotify")) void poll(); });

  async function cmd(path: string, body?: unknown) {
    msg.textContent = "";
    try { await post("spotify", path, body); setTimeout(() => void poll(), 500); } catch (e) { fail(e); }
  }

  // ---- devices ----
  async function loadDevices() {
    try {
      S.devices = (await api("spotify", "/spotify/devices")).devices;
      devEl.replaceChildren(
        h("div", { cls: "row-l" }, h("strong", {}, "Devices"), h("button", { onclick: () => void loadDevices() }, "Refresh")),
        S.devices.length ? h("div", {}, ...S.devices.map((d) => h("div", { cls: "dev" }, `${d.name} (${d.type})${d.active ? " · active" : ""}`,
          h("button", { onclick: () => void useDevice(d.id) }, "Play here")))) : h("p", { cls: "mut" }, "No devices found. Open the Spotify app on your phone or speaker, start any song, then press Refresh."));
    } catch (e) { fail(e); }
  }
  async function useDevice(id: string) {
    msg.textContent = "";
    try {
      await post("spotify", "/spotify/transfer", { deviceId: id, play: !S.pendingUri });
      if (S.pendingUri) { const uri = S.pendingUri; S.pendingUri = ""; await post("spotify", "/spotify/play", { uri, deviceId: id }); }
      devEl.replaceChildren(); setTimeout(() => void poll(), 800);
    } catch (e) { fail(e); }
  }

  // ---- search ----
  const drawResults = () => results.replaceChildren(...S.tracks.map((t) => h("div", { cls: "track" },
    artOk(t.art) ? h("img", { src: t.art, alt: "", width: "40", height: "40", referrerpolicy: "no-referrer" }) : h("div", { cls: "noart sm" }, "♪"),
    h("div", { cls: "trackinfo" }, h("div", {}, t.title), h("div", { cls: "mut small" }, `${t.artist} · ${t.album}`)),
    h("button", { cls: "pri", "aria-label": `Play ${t.title}`, onclick: async () => {
      msg.textContent = ""; S.pendingUri = t.uri;
      try { await post("spotify", "/spotify/play", { uri: t.uri }); S.pendingUri = ""; setTimeout(() => void poll(), 700); } catch (e) { fail(e); }
    } }, "▶"))));
  search.onkeydown = async (e) => {
    if (e.key !== "Enter") return;
    S.q = search.value.trim(); if (!S.q) return;
    msg.textContent = "";
    try { S.tracks = (await api("spotify", "/spotify/search?q=" + encodeURIComponent(S.q))).tracks; drawResults(); if (!S.tracks.length) results.replaceChildren(h("p", { cls: "mut" }, "No results.")); }
    catch (err) { fail(err); }
  };

  drawPlayer(); drawResults();
}
