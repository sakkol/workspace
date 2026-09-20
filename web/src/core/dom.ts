type Kid = Node | string | null | false | undefined;

/** Tiny element builder. Text is always added as a text node, so untrusted strings can never become HTML. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, any> = {}, ...kids: Kid[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "cls") e.className = v;
    else if (k.startsWith("on")) (e as any)[k] = v;
    else if (k === "value" || k === "checked" || k === "disabled") (e as any)[k] = v;
    else e.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of kids) if (c !== null && c !== false && c !== undefined) e.append(c);
  return e;
}

export const mmss = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

export function fmtDate(s: string) {
  const d = new Date(s);
  if (isNaN(+d)) return s;
  const today = new Date();
  return d.toDateString() === today.toDateString()
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" });
}

export const fmtMs = (ms: number) => mmss(ms);

/** Like el.replaceChildren(...) but skips null/false, so conditional children are easy. */
export const set = (el: Element, ...kids: Kid[]) => el.replaceChildren(...(kids.filter((k) => k !== null && k !== false && k !== undefined) as Array<Node | string>));
