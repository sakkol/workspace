import { describe, expect, it } from "vitest";
import { Timer, fmtHMS, parseMinutes, MAX_MS } from "../src/widgets/timerCore";
import { fmtDay, fmtTime, validZone } from "../src/widgets/clockCore";
import { safeLinks } from "../src/widgets/links";

describe("timer", () => {
  const make = () => { const c = { t: 0 }; return { c, tm: new Timer(() => c.t) }; };

  it("counts down from timestamps and finishes exactly once", () => {
    const { c, tm } = make(); tm.setDuration(60_000);
    expect(tm.start()).toBe(true);
    c.t = 10_000; expect(tm.remaining()).toBe(50_000); expect(tm.tick()).toBe(false);
    c.t = 60_000; expect(tm.tick()).toBe(true); expect(tm.state).toBe("done"); expect(tm.remaining()).toBe(0);
    expect(tm.tick()).toBe(false);
  });
  it("is not fooled by long gaps between ticks (background tabs)", () => {
    const { c, tm } = make(); tm.setDuration(60_000); tm.start();
    c.t = 5 * 60_000; // the tab slept for five minutes
    expect(tm.tick()).toBe(true); expect(tm.remaining()).toBe(0);
  });
  it("pause keeps the remaining time and resume continues from it", () => {
    const { c, tm } = make(); tm.setDuration(60_000); tm.start();
    c.t = 20_000; tm.pause(); expect(tm.state).toBe("paused"); expect(tm.remaining()).toBe(40_000);
    c.t = 100_000; expect(tm.remaining()).toBe(40_000); expect(tm.tick()).toBe(false);
    tm.start(); c.t = 110_000; expect(tm.remaining()).toBe(30_000);
  });
  it("reset returns to the full duration; start is ignored while running or done", () => {
    const { c, tm } = make(); tm.setDuration(30_000); tm.start(); expect(tm.start()).toBe(false);
    c.t = 40_000; tm.tick(); expect(tm.start()).toBe(false);
    tm.reset(); expect(tm.state).toBe("idle"); expect(tm.remaining()).toBe(30_000);
  });
  it("clamps durations and ignores garbage", () => {
    const { tm } = make();
    tm.setDuration(0); expect(tm.totalMs).toBe(1000);
    tm.setDuration(1e12); expect(tm.totalMs).toBe(MAX_MS);
    tm.setDuration(90_000); tm.setDuration(NaN); expect(tm.totalMs).toBe(90_000);
  });
  it("changing the duration while running returns to idle", () => {
    const { c, tm } = make(); tm.start(); c.t = 5000; tm.setDuration(60_000);
    expect(tm.state).toBe("idle"); expect(tm.remaining()).toBe(60_000);
  });
  it("parseMinutes accepts sensible input only", () => {
    expect(parseMinutes("25")).toBe(1_500_000); expect(parseMinutes(" 1.5 ")).toBe(90_000); expect(parseMinutes("999")).toBe(MAX_MS);
    for (const bad of ["", "0", "1000", "abc", "-5", "2.55", "1e3", "1,5", "0.0"]) expect(parseMinutes(bad)).toBeNull();
  });
  it("fmtHMS rounds up and switches to hours", () => {
    expect(fmtHMS(0)).toBe("00:00"); expect(fmtHMS(61_000)).toBe("01:01"); expect(fmtHMS(59_001)).toBe("01:00");
    expect(fmtHMS(3_600_000)).toBe("1:00:00"); expect(fmtHMS(-5)).toBe("00:00");
  });
});

describe("clock", () => {
  const d = new Date("2026-09-21T14:05:09Z");
  const norm = (s: string) => s.replace(/\s/g, " ");
  it("formats 24h and 12h in a given zone", () => {
    expect(fmtTime(d, false, "UTC", "en-GB")).toBe("14:05:09");
    expect(norm(fmtTime(d, true, "UTC", "en-US"))).toBe("02:05:09 PM");
    expect(fmtTime(d, false, "Asia/Tokyo", "en-GB")).toBe("23:05:09");
  });
  it("formats the date", () => { expect(fmtDay(d, "UTC", "en-GB")).toContain("21 September 2026"); });
  it("validates zones", () => { expect(validZone("Europe/Istanbul")).toBe(true); expect(validZone("Mars/Base")).toBe(false); });
});

describe("quick links", () => {
  it("keeps https links only and normalises them", () => {
    const out = safeLinks([
      { name: "ok", url: "https://example.com" }, { name: "js", url: "javascript:alert(1)" }, { name: "http", url: "http://example.com" },
      { name: "data", url: "data:text/html,<script>1</script>" }, { name: "bad", url: "not a url" }, { name: "  ", url: "https://blank.example" },
    ]);
    expect(out).toEqual([{ name: "ok", url: "https://example.com/" }]);
  });
});
