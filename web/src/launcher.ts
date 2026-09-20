import { h, mmss, set } from "./core/dom";
import { lockAll, lockApp } from "./core/api";
import { caps, every, go, rerender, takeNotice, AppId, Access } from "./core/state";
import { TILES } from "./apps/registry";

const choice: Record<string, Access> = { gmail: "read", spotify: "write" }; // least privilege by default

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

    const opts = t.accessChoices ?? ["write"];
    const radios = opts.length > 1
      ? h("div", { cls: "choices" }, ...opts.map((a) => h("label", {},
          h("input", { type: "radio", name: "acc-" + t.id, checked: choice[t.id] === a, onchange: () => { choice[t.id] = a; } }),
          a === "read" ? " Read only" : " Read & write")))
      : null;
    return h("div", { cls: "tile" }, ...kids, h("div", { cls: "small" }, "🔒 Locked"), radios,
      h("div", { cls: "row-l" }, h("button", { cls: "pri", onclick: () => go({ n: "unlock", app: t.id as AppId, access: opts.length > 1 ? choice[t.id] : opts[0] }) }, "Unlock")));
  });

  set(root,
    notice ? h("p", { cls: "notice", role: "status" }, notice) : null,
    h("div", { cls: "bar" }, h("div", {}, h("strong", {}, "Your workspace"), h("div", { cls: "mut small" }, "Unlock an app with your phone.")),
      caps.size ? h("button", { cls: "done", onclick: async () => { await lockAll(); rerender(); } }, "DONE — lock everything") : null),
    h("div", { cls: "grid" }, ...tiles),
    h("p", { cls: "mut small" }, "Nothing is saved on this computer. Refreshing or closing this page locks everything. Use “Read only” on computers you trust least."));
  every(() => timers.forEach((f) => f()), 1000);
}
