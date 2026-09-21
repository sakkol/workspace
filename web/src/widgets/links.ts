import { h } from "../core/dom";
import { QUICK_LINKS, QuickLink } from "../config";

/** Keep only well-formed https links (protects against typos like "javascript:" in config.ts). */
export function safeLinks(list: QuickLink[]): QuickLink[] {
  return list.flatMap((l) => {
    try {
      const u = new URL(l.url);
      return u.protocol === "https:" && l.name.trim() ? [{ ...l, name: l.name.trim(), url: u.href }] : [];
    } catch { return []; }
  });
}

/** The owner's own, static links from config.ts. (Vendor content such as email text is never made clickable.) */
export function linksWidget(): HTMLElement | null {
  const items = safeLinks(QUICK_LINKS);
  if (!items.length) return null;
  return h("div", { cls: "card wide" },
    h("div", { cls: "cardh" }, h("strong", {}, "🔗 Quick links")),
    h("div", { cls: "links" }, ...items.map((l) =>
      h("a", { cls: "linkchip", href: l.url, target: "_blank", rel: "noopener noreferrer" }, (l.icon ? l.icon + " " : "") + l.name))),
    h("p", { cls: "mut small" }, "These open the real websites in a new tab. If a site asks you to sign in, only do that on a computer you trust."));
}
