import { h } from "../core/dom";
import { every } from "../core/state";
import { EXTRA_CLOCKS } from "../config";
import { fmtDay, fmtTime, validZone } from "./clockCore";

let hour12 = false; // in memory only: nothing is stored on the computer

export function clockWidget(): HTMLElement {
  const time = h("div", { cls: "cbig", "aria-live": "off" });
  const day = h("div", { cls: "mut" });
  const extras = EXTRA_CLOCKS.filter((c) => validZone(c.timeZone)).map((c) => ({ c, el: h("div", { cls: "cextra" }) }));
  const toggle = h("button", { cls: "tiny", "aria-label": "Switch between 12 and 24 hour clock" });
  toggle.onclick = () => { hour12 = !hour12; paint(); };

  function paint() {
    const now = new Date();
    time.textContent = fmtTime(now, hour12);
    day.textContent = fmtDay(now);
    toggle.textContent = hour12 ? "12h" : "24h";
    for (const { c, el } of extras) el.textContent = `${c.label}: ${fmtTime(now, hour12, c.timeZone)}`;
  }
  paint(); every(paint, 1000);

  return h("div", { cls: "card" }, h("div", { cls: "cardh" }, h("strong", {}, "🕒 Clock"), toggle), time, day, ...extras.map((e) => e.el));
}
