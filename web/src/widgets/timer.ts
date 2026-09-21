import { h } from "../core/dom";
import { go, onLeave } from "../core/state";
import { Timer, fmtHMS, parseMinutes } from "./timerCore";

// One timer for the whole page. It keeps running while you use Gmail or Spotify. In memory only: a refresh resets it.
const timer = new Timer();
const subs = new Set<() => void>();
const notify = () => subs.forEach((f) => f());

// ---- alarm: sound is scheduled on the audio clock, so it still fires on time when the tab is in the background ----
let ctx: AudioContext | null = null;
let scheduled: OscillatorNode[] = [];
function ensureAudio() { // must be called from a click (browsers block audio otherwise)
  try {
    const AC = window.AudioContext || (window as any).webkitAudioContext;
    if (!ctx && AC) ctx = new AC();
    void ctx?.resume();
  } catch { ctx = null; }
}
function cancelAlarm() {
  for (const o of scheduled) { try { o.stop(); } catch { /* not started */ } try { o.disconnect(); } catch { /* ignore */ } }
  scheduled = [];
}
function scheduleAlarm(inMs: number) {
  cancelAlarm();
  if (!ctx) return;
  const t0 = ctx.currentTime + inMs / 1000;
  for (let i = 0; i < 8; i++) {
    const o = ctx.createOscillator(), g = ctx.createGain(), s = t0 + i * 0.4;
    o.type = "sine"; o.frequency.value = i % 2 ? 660 : 880;
    g.gain.setValueAtTime(0.0001, s); g.gain.exponentialRampToValueAtTime(0.3, s + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, s + 0.3);
    o.connect(g).connect(ctx.destination); o.start(s); o.stop(s + 0.32);
    scheduled.push(o);
  }
}

// ---- tab title: shows the countdown, and flashes when finished ----
const baseTitle = document.title;
let flash = 0;
function paintTitle() {
  if (flash) return;
  document.title = timer.state === "running" ? `⏱ ${fmtHMS(timer.remaining())} · ${baseTitle}` : baseTitle;
}
function stopFlash() { if (flash) { clearInterval(flash); flash = 0; } document.title = baseTitle; }
function startFlash() {
  let on = false;
  flash = window.setInterval(() => { on = !on; document.title = on ? "⏰ Time's up!" : baseTitle; }, 800);
}

// ---- actions ----
export const actions = {
  start() { ensureAudio(); if (timer.start()) scheduleAlarm(timer.remaining()); notify(); },
  pause() { timer.pause(); cancelAlarm(); paintTitle(); notify(); },
  reset() { timer.reset(); cancelAlarm(); stopFlash(); notify(); },
  set(ms: number) { timer.setDuration(ms); cancelAlarm(); stopFlash(); notify(); },
};

setInterval(() => {
  const finished = timer.tick();
  if (finished) startFlash();
  if (timer.state === "running" || finished) { paintTitle(); notify(); }
}, 250);

// ---- header chip: visible on every screen while the timer is active ----
let chipEl: HTMLButtonElement | null = null;
export function timerChip(): HTMLElement {
  if (!chipEl) {
    const c = h("button", { cls: "chip", title: "Go to the timer" }) as HTMLButtonElement;
    c.hidden = true;
    c.onclick = () => go({ n: "launcher" });
    subs.add(() => {
      c.hidden = timer.state === "idle";
      c.textContent = timer.state === "done" ? "⏰ Time's up!" : `${timer.state === "paused" ? "⏸" : "⏱"} ${fmtHMS(timer.remaining())}`;
      c.classList.toggle("alarm", timer.state === "done");
    });
    chipEl = c;
  }
  return chipEl;
}

// ---- the widget on the launcher ----
const PRESETS = [5, 10, 25, 45];

export function timerWidget(): HTMLElement {
  const disp = h("div", { cls: "cbig tdisp", role: "timer" });
  const err = h("div", { cls: "err small", role: "alert" });
  const main = h("button", { cls: "pri" }) as HTMLButtonElement;
  const reset = h("button", {}, "Reset") as HTMLButtonElement;
  const presets = PRESETS.map((m) => h("button", { cls: "tiny", onclick: () => { err.textContent = ""; actions.set(m * 60_000); } }, `${m} min`) as HTMLButtonElement);
  const custom = h("input", { type: "text", inputmode: "decimal", placeholder: "minutes", "aria-label": "Custom minutes", maxlength: "5", cls: "tinput" }) as HTMLInputElement;
  const setBtn = h("button", { cls: "tiny" }, "Set") as HTMLButtonElement;
  const apply = () => {
    const ms = parseMinutes(custom.value);
    if (ms === null) { err.textContent = "Enter minutes, for example 15 or 7.5 (up to 999)."; return; }
    err.textContent = ""; custom.value = ""; actions.set(ms);
  };
  setBtn.onclick = apply;
  custom.onkeydown = (e) => { if (e.key === "Enter") apply(); };

  main.onclick = () => {
    if (timer.state === "running") actions.pause();
    else if (timer.state === "done") actions.reset();
    else actions.start();
  };
  reset.onclick = () => actions.reset();

  const card = h("div", { cls: "card" },
    h("div", { cls: "cardh" }, h("strong", {}, "⏱ Timer")),
    disp,
    h("div", { cls: "row-l" }, main, reset),
    h("div", { cls: "presets" }, ...presets, custom, setBtn),
    err,
    h("p", { cls: "mut small" }, "Keeps running while you use other apps. A page refresh resets it."));

  const paint = () => {
    const s = timer.state;
    disp.textContent = s === "done" ? "Time's up!" : fmtHMS(timer.remaining());
    main.textContent = s === "running" ? "Pause" : s === "paused" ? "Resume" : s === "done" ? "Dismiss" : "Start";
    reset.disabled = s === "idle" && timer.remaining() === timer.totalMs;
    presets.forEach((b) => { b.disabled = s === "running"; });
    custom.disabled = setBtn.disabled = s === "running";
    card.classList.toggle("alarm", s === "done");
  };
  paint();
  subs.add(paint);
  onLeave(() => subs.delete(paint)); // the launcher is rebuilt on every render
  return card;
}
