import { h, mmss, set } from "./core/dom";
import { lockAll, lockApp } from "./core/api";
import { caps, every, go, rerender, takeNotice, APP_NAMES, AppId, Access } from "./core/state";
import { TILES } from "./apps/registry";
import { clockWidget } from "./widgets/clock";
import { timerWidget } from "./widgets/timer";
import { linksWidget } from "./widgets/links";

// The Spotify web player lives on its OWN site (different origin) because it loads Spotify's script. The workspace only
// opens it in a new tab: no token, capability or message ever passes between the two sites.
const PLAYER_URL = ((import.meta.env.VITE_PLAYER_URL as string | undefined) || "").trim();
interface Mode { id: string; label: string; access?: Access; open?: string }
const MODES: Record<string, Mode[]> = {
  gmail: [{ id: "read", label: "Read only", access: "read" }, { id: "write", label: "Read & write", access: "write" }],
  outlook: [{ id: "read", label: "Read only", access: "read" }, { id: "write", label: "Read & write", access: "write" }],
  tasks: [{ id: "read", label: "Read only", access: "read" }, { id: "write", label: "Read & write", access: "write" }],
  notion: [{ id: "read", label: "Read only", access: "read" }, { id: "write", label: "Read & write", access: "write" }],
  spotify: [
    ...(PLAYER_URL ? [{ id: "player", label: "Web player (opens a new tab)", open: PLAYER_URL }] : []),
    { id: "remote", label: "Remote control (plays on your phone or speaker)", access: "write" as Access },
  ],
};
// Google apps can be unlocked together with ONE sign-in. Off by default; the partner has its own access level (read-only by default).
const PARTNER: Record<string, AppId> = { gmail: "tasks", tasks: "gmail" };
const bundle: Record<string, { on: boolean; access: Access }> = { gmail: { on: false, access: "read" }, tasks: { on: false, access: "read" } };
const choice: Record<string, string> = { gmail: "read", outlook: "read", tasks: "read", notion: "read", spotify: PLAYER_URL ? "player" : "remote" }; // least privilege by default

export function launcher(root: HTMLElement) {
  const notice = takeNotice();
  const timers: Array<() => void> = [];

  const tiles = TILES.map((t) => {
    const cap = t.status === "available" ? caps.get(t.id as AppId) : undefined;
    const kids: (Node | string | false)[] = [h("div", { cls: "ico" }, t.icon), h("strong", {}, t.name), h("div", { cls: "mut small" }, t.blurb)];

    if (t.status === "soon") return h("div", { cls: "tile soon" }, ...kids, h("div", { cls: "mut small" }, "Coming soon"));

    if (cap) {
      const cd = h("span");
      const upd = () => { cd.textContent = mmss(cap.expAt - Date.now()); };
      upd(); timers.push(upd);
      return h("div", { cls: "tile open" }, ...kids,
        h("div", { cls: "small" }, h("span", { cls: "dot" }), cap.access === "write" ? "Unlocked · read & write" : "Unlocked · read only", " · ", cd),
        h("div", { cls: "row-l" },
          h("button", { cls: "pri", onclick: () => go({ n: "app", app: t.id as AppId }) }, "Open"),
          h("button", { onclick: async () => { await lockApp(t.id as AppId); rerender(); } }, "Lock")));
    }

    const modes = MODES[t.id] ?? [];
    const radios = modes.length > 1
      ? h("div", { cls: "choices" }, ...modes.map((m) => h("label", {},
          h("input", { type: "radio", name: "acc-" + t.id, checked: choice[t.id] === m.id, onchange: () => { choice[t.id] = m.id; } }),
          " " + m.label)))
      : null;
    const unlock = () => {
      const m = modes.find((x) => x.id === choice[t.id]) ?? modes[0];
      if (!m) return;
      if (m.open) window.open(m.open, "_blank", "noopener,noreferrer"); // noopener: the new tab gets no handle on this page
      else {
        const partner = PARTNER[t.id], b = bundle[t.id];
        const also = partner && b?.on && !caps.has(partner) ? [{ app: partner, access: b.access }] : undefined;
        go({ n: "unlock", app: t.id as AppId, access: m.access!, also });
      }
    };
    const partner = PARTNER[t.id];
    const pb = partner ? bundle[t.id] : undefined;
    const together = partner && pb && !caps.has(partner)
      ? h("div", { cls: "choices" },
          h("label", {}, h("input", { type: "checkbox", checked: pb.on, onchange: (e: Event) => { pb.on = (e.target as HTMLInputElement).checked; rerender(); } }), ` Also unlock ${APP_NAMES[partner]} (same sign-in)`),
          pb.on ? h("div", { cls: "sub-choices" }, ...(["read", "write"] as Access[]).map((a) => h("label", {},
            h("input", { type: "radio", name: "also-" + t.id, checked: pb.access === a, onchange: () => { pb.access = a; } }),
            ` ${APP_NAMES[partner]}: ${a === "read" ? "read only" : "read & write"}`))) : null)
      : null;
    return h("div", { cls: "tile" }, ...kids, h("div", { cls: "small" }, "🔒 Locked"), radios, together,
      h("div", { cls: "row-l" }, h("button", { cls: "pri", onclick: unlock }, "Unlock")));
  });

  set(root,
    notice ? h("p", { cls: "notice", role: "status" }, notice) : null,
    h("div", { cls: "bar" }, h("div", {}, h("strong", {}, "Your workspace"), h("div", { cls: "mut small" }, "Unlock an app with your phone.")),
      caps.size ? h("button", { cls: "done", onclick: async () => { await lockAll(); rerender(); } }, "DONE — lock everything") : null),
    h("div", { cls: "grid" }, ...tiles),
    h("div", { cls: "widgets" }, clockWidget(), timerWidget()),
    linksWidget(),
    h("p", { cls: "mut small" }, "Nothing is saved on this computer. Refreshing or closing this page locks everything. Use “Read only” on computers you trust least."));
  every(() => timers.forEach((f) => f()), 1000);
}
