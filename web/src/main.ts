import { h } from "./core/dom";
import { lockAll } from "./core/api";
import { caps, go, resetView, sessionEnded, setRenderer, view, APP_NAMES, AppId } from "./core/state";
import { launcher } from "./launcher";
import { unlockView } from "./link/computer";
import { phoneView } from "./link/phone";
import { MOUNT } from "./apps/registry";

// This page must never be shown inside another site (GitHub Pages cannot send frame-ancestors headers).
if (window.top !== window.self) {
  document.body.textContent = "This page cannot be shown inside another site.";
  throw new Error("framed");
}

const root = document.getElementById("app")!;

function render() {
  resetView();
  const body = h("section");
  root.className = view.n === "app" ? "wide" : "";
  root.replaceChildren(h("h1", { cls: "brand" }, "Sakkol"), body);
  switch (view.n) {
    case "launcher": return launcher(body);
    case "unlock": return void unlockView(body, view.app, view.access);
    case "phone": return void phoneView(body, view.id, view.sub);
    case "app":
      if (!caps.has(view.app)) return go({ n: "launcher" });
      return MOUNT[view.app](body);
  }
}
setRenderer(render);

// Client-side session timers (UX only: the Relay is the authority and enforces expiry on every request).
setInterval(() => {
  for (const [app, c] of caps) if (Date.now() >= c.expAt) sessionEnded(app as AppId, `${APP_NAMES[app]} session ended (time limit).`);
}, 1000);

function route() {
  const m = location.hash.match(/^#\/p\/([\w-]+)\/?(.*)$/);
  if (m) { void lockAll(); go({ n: "phone", id: m[1], sub: m[2] }); }   // the phone page never holds capabilities
  else if (view.n === "phone") go({ n: "launcher" });
  else render();
}
window.addEventListener("hashchange", route);
route();
