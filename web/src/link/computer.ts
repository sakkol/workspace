import QRCode from "qrcode";
import { h, mmss } from "../core/dom";
import { relay, errText, ApiError } from "../core/api";
import { randomB64u, sha256b64u } from "../core/crypto";
import { caps, every, go, onLeave, APP_NAMES, AppId, Access } from "../core/state";

/** Unlock one app from the shared computer: QR + code, poll with the claim secret, claim the capability. */
export async function unlockView(root: HTMLElement, app: AppId, access: Access) {
  let alive = true;
  let txId = "";
  const claimSecret = randomB64u(32); // lives in this closure only; never displayed, stored or put in the QR
  const auth = { "X-Claim-Secret": claimSecret };
  onLeave(() => {
    alive = false;
    if (txId) relay("/link/cancel/" + txId, { method: "POST" }, auth).catch(() => {}); // no-op if already claimed
  });

  const back = h("button", { onclick: () => go({ n: "launcher" }) }, "Back");
  const fail = (text: string) => root.replaceChildren(
    h("h2", {}, `Unlock ${APP_NAMES[app]}`), h("p", {}, text),
    h("div", { cls: "row" }, h("button", { cls: "pri", onclick: () => go({ n: "unlock", app, access }) }, "Try again"), back));

  root.replaceChildren(h("p", { cls: "mut" }, "Preparing secure link…"));
  let tx: { id: string; code: string; ttlMs: number };
  try {
    tx = await relay("/link/start", { method: "POST", body: JSON.stringify({ app, access, claimHash: await sha256b64u(claimSecret) }) });
  } catch (e) { return alive && fail(errText(e)); }
  if (!alive) { relay("/link/cancel/" + tx.id, { method: "POST" }, auth).catch(() => {}); return; }
  txId = tx.id;

  const expAt = Date.now() + tx.ttlMs; // relative to *our* clock: no clock-skew problems
  const canvas = document.createElement("canvas");
  await QRCode.toCanvas(canvas, `${location.origin}${location.pathname}#/p/${tx.id}`, { width: 240, margin: 2 });
  if (!alive) return;
  const left = h("span");
  root.replaceChildren(h("div", { cls: "center" },
    h("h2", {}, `Unlock ${APP_NAMES[app]}`),
    canvas,
    h("div", { cls: "code", "aria-label": "verification code" }, tx.code),
    h("p", {}, "1. Scan the QR code with your phone.", h("br"), "2. Type this code on your phone when asked.", h("br"), "3. Approve on Google's / Spotify's own page."),
    h("p", { cls: "mut small" }, "Your password is never typed on this computer. Only continue if you started this yourself."),
    h("p", { cls: "mut" }, "Expires in ", left),
    h("div", { cls: "row" }, back)));
  const tick = () => { left.textContent = mmss(expAt - Date.now()); };
  tick(); every(tick, 1000);

  let busy = false;
  every(async () => {
    if (busy || !alive) return;
    busy = true;
    try {
      const { status } = await relay("/link/status/" + tx.id, {}, auth);
      if (!alive) return;
      if (status === "approved") {
        alive = false;
        root.replaceChildren(h("p", { cls: "mut" }, "Signing in…"));
        try {
          const r = await relay("/link/claim/" + tx.id, { method: "POST" }, auth);
          txId = ""; // claimed: nothing left to cancel
          caps.set(app, { cap: r.cap, expAt: Date.now() + r.ttlMs, access: r.access });
          go({ n: "app", app });
        } catch (e) { fail(e instanceof ApiError && e.status === 409 ? "This link was already used or expired." : errText(e)); }
      } else if (status === "expired") { alive = false; txId = ""; fail("This code expired or was cancelled."); }
      else if (status === "cancelled") { alive = false; txId = ""; fail("Approval was cancelled, the wrong code was entered too often, or authorization failed."); }
      else if (status === "consumed") { alive = false; txId = ""; fail("This link was already used."); }
    } catch { /* network blip: keep polling */ }
    finally { busy = false; }
  }, 2000);
}
