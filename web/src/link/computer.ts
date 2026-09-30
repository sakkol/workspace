import QRCode from "qrcode";
import { h, mmss } from "../core/dom";
import { relay, errText, ApiError } from "../core/api";
import { randomB64u, sha256b64u } from "../core/crypto";
import { caps, every, go, onLeave, APP_NAMES, AppId, Access } from "../core/state";

/** Unlock one app from the shared computer: QR + code, poll with the claim secret, claim the capability. */
export async function unlockView(root: HTMLElement, app: AppId, access: Access, also: Array<{ app: AppId; access: Access }> = []) {
  let alive = true;
  let txId = "";
  const claimSecret = randomB64u(32); // lives in this closure only; never displayed, stored or put in the QR
  const auth = { "X-Claim-Secret": claimSecret };
  onLeave(() => {
    alive = false;
    if (txId) relay("/link/cancel/" + txId, { method: "POST" }, auth).catch(() => {}); // no-op if already claimed
  });

  const names = [app, ...also.map((a) => a.app)].map((a) => APP_NAMES[a]).join(" + "); // Google bundle: one sign-in for several apps
  const back = h("button", { onclick: () => go({ n: "launcher" }) }, "Back");
  const fail = (text: string) => root.replaceChildren(
    h("h2", {}, `Unlock ${names}`), h("p", {}, text),
    h("div", { cls: "row" }, h("button", { cls: "pri", onclick: () => go({ n: "unlock", app, access, also }) }, "Try again"), back));

  root.replaceChildren(h("p", { cls: "mut" }, "Preparing secure link…"));
  let tx: { id: string; code: string; ttlMs: number };
  try {
    tx = await relay("/link/start", { method: "POST", body: JSON.stringify({ app, access, ...(also.length ? { also } : {}), claimHash: await sha256b64u(claimSecret) }) });
  } catch (e) { return alive && fail(errText(e)); }
  if (!alive) { relay("/link/cancel/" + tx.id, { method: "POST" }, auth).catch(() => {}); return; }
  txId = tx.id;

  const expAt = Date.now() + tx.ttlMs; // relative to *our* clock: no clock-skew problems
  const canvas = document.createElement("canvas");
  await QRCode.toCanvas(canvas, `${location.origin}${location.pathname}#/p/${tx.id}`, { width: 240, margin: 2 });
  if (!alive) return;
  const left = h("span");
  root.replaceChildren(h("div", { cls: "center" },
    h("h2", {}, `Unlock ${names}`),
    also.length ? h("p", { cls: "mut small" }, "One Google sign-in unlocks all of these. Your phone will list each one and what it can do.") : null,
    canvas,
    h("div", { cls: "code", "aria-label": "verification code" }, tx.code),
    h("p", {}, "1. Scan the QR code with your phone.", h("br"), "2. Type this code on your phone when asked.", h("br"), "3. Approve on Google's / Microsoft's / Spotify's own page."),
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
          // one capability per app; the top-level fields are the primary app (older Relay versions)
          const got: Record<string, { cap: string; ttlMs: number; access: Access }> = r.caps ?? { [app]: { cap: r.cap, ttlMs: r.ttlMs, access: r.access } };
          for (const a of [app, ...also.map((x) => x.app)]) if (got[a]) caps.set(a, { cap: got[a].cap, expAt: Date.now() + got[a].ttlMs, access: got[a].access });
          go({ n: "app", app });
        } catch (e) { fail(e instanceof ApiError && e.status === 409 ? "This link was already used or expired." : errText(e)); }
      } else if (status === "expired") { alive = false; txId = ""; fail("This code expired or was cancelled."); }
      else if (status === "cancelled") { alive = false; txId = ""; fail("Approval was cancelled, the wrong code was entered too often, or authorization failed."); }
      else if (status === "consumed") { alive = false; txId = ""; fail("This link was already used."); }
    } catch { /* network blip: keep polling */ }
    finally { busy = false; }
  }, 2000);
}
