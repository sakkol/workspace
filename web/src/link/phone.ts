import { h } from "../core/dom";
import { relay, RELAY, ApiError } from "../core/api";

const REASONS: Record<string, string> = {
  expired: "The request expired. Start again from the computer.",
  state: "This approval link is no longer valid. Start again from the computer.",
  denied: "Authorization was cancelled or denied.",
  failed: "The sign-in with the provider failed. Start again from the computer.",
  scope: "You did not grant the requested permission. Start again and leave the permission ticked, or choose “Read only”.",
};

const NOTE = "Approving creates a “connected app” entry on your Google / Spotify account. It stays there until you remove it (myaccount.google.com/permissions, spotify.com/account/apps), even after this session ends.";

/** The trusted phone page. Never holds capabilities and never asks for a provider password. */
export async function phoneView(root: HTMLElement, id: string, sub: string) {
  if (sub === "done")
    return root.replaceChildren(h("h2", {}, "Connected ✓"), h("p", {}, "Return to the shared computer. You can close this page."), h("p", { cls: "mut small" }, NOTE));
  if (sub.startsWith("error")) {
    const r = new URLSearchParams(sub.split("?")[1] || "").get("r") || "expired";
    return root.replaceChildren(h("h2", {}, "Not connected"), h("p", {}, REASONS[r] ?? REASONS.expired));
  }
  root.replaceChildren(h("p", { cls: "mut" }, "Loading…"));
  let info: any;
  try { info = await relay("/link/info/" + id); }
  catch { return root.replaceChildren(h("h2", {}, "Request not found"), h("p", {}, "It expired or is invalid. Start again from the computer.")); }

  const where = [info.ctx.city, info.ctx.country].filter(Boolean).join(", ") || "an unknown location";
  const msg = h("p", { cls: "err", role: "alert" });
  const input = h("input", { type: "text", inputmode: "numeric", pattern: "[0-9]*", maxlength: "6", autocomplete: "off", placeholder: "000000", "aria-label": "6-digit code", cls: "codein" });
  const go = h("button", { cls: "pri" }, "Continue");
  const cancel = h("button", {}, "Cancel");

  go.onclick = async () => {
    const code = (input as HTMLInputElement).value.trim();
    if (!/^\d{6}$/.test(code)) { msg.textContent = "Enter the 6 digits shown on the computer."; return; }
    go.disabled = true; msg.textContent = "";
    try {
      const c = await relay(`/link/confirm/${id}`, { method: "POST", body: JSON.stringify({ code }) });
      location.href = `${RELAY}/oauth/${info.vendor}?tx=${encodeURIComponent(id)}&n=${encodeURIComponent(c.nonce)}`;
    } catch (e) {
      go.disabled = false;
      if (e instanceof ApiError && e.status === 403) msg.textContent = "That code does not match. Check the computer screen.";
      else root.replaceChildren(h("h2", {}, "Request cancelled"), h("p", {}, "It expired or too many wrong codes were entered. Start again from the computer."));
    }
  };
  cancel.onclick = async () => { try { await relay(`/link/cancel/${id}`, { method: "POST" }); } catch { /* ignore */ } root.replaceChildren(h("h2", {}, "Cancelled")); };

  root.replaceChildren(
    h("h2", {}, `Unlock ${info.label} on a computer?`),
    h("p", {}, info.describe),
    h("div", { cls: "ctx" }, h("div", {}, h("strong", {}, "Request from: "), info.ctx.ua || "unknown browser"), h("div", {}, h("strong", {}, "Near: "), where), h("div", { cls: "mut" }, `Started ${info.ageSec} s ago`)),
    h("p", { cls: "warn" }, "⚠ Only continue if you are sitting at this computer right now. If someone sent you this link, cancel."),
    h("label", {}, "Type the 6-digit code shown on the computer:"), input, msg,
    h("div", { cls: "row" }, go, cancel),
    h("p", { cls: "mut small" }, NOTE));
  (input as HTMLInputElement).focus();
}
