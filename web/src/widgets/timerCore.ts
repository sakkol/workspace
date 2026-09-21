/** Countdown timer logic. Pure (the clock is injected), so it is testable and immune to background-tab throttling:
 *  remaining time is always computed from timestamps, never by counting ticks. */
export type TimerState = "idle" | "running" | "paused" | "done";
export const MIN_MS = 1000;
export const MAX_MS = 999 * 60_000;

/** "25" -> 1500000, "1.5" -> 90000. Minutes with at most one decimal, 1 s to 999 min. Anything else -> null. */
export function parseMinutes(s: string): number | null {
  const t = s.trim();
  if (!/^\d{1,3}(\.\d)?$/.test(t)) return null;
  const ms = Math.round(parseFloat(t) * 60_000);
  return ms >= MIN_MS && ms <= MAX_MS ? ms : null;
}

/** 61000 -> "01:01", 3600000 -> "1:00:00". Rounds up so the display reaches 00:00 exactly when the timer ends. */
export function fmtHMS(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  const p = (n: number) => String(n).padStart(2, "0");
  return hh > 0 ? `${hh}:${p(mm)}:${p(ss)}` : `${p(mm)}:${p(ss)}`;
}

export class Timer {
  state: TimerState = "idle";
  totalMs = 25 * 60_000;
  private left = 25 * 60_000;
  private endAt = 0;
  constructor(private now: () => number = () => Date.now()) {}

  /** Changing the duration always returns to "idle". */
  setDuration(ms: number) {
    if (!Number.isFinite(ms)) return;
    this.totalMs = Math.min(MAX_MS, Math.max(MIN_MS, Math.round(ms)));
    this.reset();
  }
  reset() { this.state = "idle"; this.left = this.totalMs; this.endAt = 0; }
  /** Start or resume. Returns false if it was already running or finished. */
  start(): boolean {
    if (this.state === "running" || this.state === "done") return false;
    this.endAt = this.now() + this.left;
    this.state = "running";
    return true;
  }
  pause() {
    if (this.state !== "running") return;
    this.left = Math.max(0, this.endAt - this.now());
    this.state = "paused";
  }
  remaining(): number {
    if (this.state === "running") return Math.max(0, this.endAt - this.now());
    return this.state === "done" ? 0 : this.left;
  }
  /** Call regularly. Returns true exactly once, at the moment the timer finishes. */
  tick(): boolean {
    if (this.state === "running" && this.now() >= this.endAt) { this.state = "done"; this.left = 0; return true; }
    return false;
  }
}
