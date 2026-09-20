import { h } from "../../core/dom";
import { post, errText, ApiError } from "../../core/api";
import { S, Shell } from "./index";

export interface Draft { to: string; cc: string; subject: string; body: string; replyToId?: string }

const ADDR = /^[^\s<>"',;()\[\]\\@]+@[^\s<>"',;()\[\]\\@]+\.[^\s<>"',;()\[\]\\@]+$/;
const split = (s: string) => s.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);

/** Compose lives only in this DOM tree: a refresh or lock discards it. Nothing is auto-saved anywhere. */
export function composeView(sh: Shell, init: Draft = { to: "", cc: "", subject: "", body: "" }) {
  const d: Draft = { ...init };
  const err = h("p", { cls: "err", role: "alert" });
  const field = (label: string, el: HTMLElement) => h("label", { cls: "field" }, h("span", {}, label), el);
  const to = h("input", { type: "text", value: d.to, placeholder: "name@example.com, other@example.com", autocomplete: "off", "aria-label": "To" });
  const cc = h("input", { type: "text", value: d.cc, placeholder: "optional", autocomplete: "off", "aria-label": "Cc" });
  const subject = h("input", { type: "text", value: d.subject, maxlength: "150", autocomplete: "off", "aria-label": "Subject" });
  const body = h("textarea", { rows: "12", value: d.body, "aria-label": "Message" });

  const sync = () => { d.to = to.value; d.cc = cc.value; d.subject = subject.value; d.body = body.value; };

  const review = () => {
    sync();
    const T = split(d.to), C = split(d.cc);
    if (T.length + C.length === 0) { err.textContent = "Add at least one recipient."; return; }
    if (T.length + C.length > 10) { err.textContent = "Too many recipients (10 maximum)."; return; }
    const badAddr = [...T, ...C].find((a) => !ADDR.test(a));
    if (badAddr) { err.textContent = `“${badAddr}” is not a valid address. Use plain addresses separated by commas.`; return; }
    err.textContent = "";
    const send = h("button", { cls: "pri" }, "Send");
    const state = h("p", { cls: "err", role: "alert" });
    send.onclick = async () => {
      send.disabled = true; state.textContent = "";
      try {
        await post("gmail", "/gmail/send", { to: T, cc: C, subject: d.subject, body: d.body, replyToId: d.replyToId });
        sh.toast("Message sent");
        S.msgs = []; S.next = null;
        sh.showList();
      } catch (e) {
        send.disabled = false;
        if (!(e instanceof ApiError && e.status === 401)) state.textContent = errText(e);
      }
    };
    sh.pane.replaceChildren(
      h("h2", {}, "Review and send"),
      h("div", { cls: "review" },
        h("div", {}, h("strong", {}, "To: "), T.join(", ")), C.length ? h("div", {}, h("strong", {}, "Cc: "), C.join(", ")) : null,
        h("div", {}, h("strong", {}, "Subject: "), d.subject || "(no subject)"), h("pre", { cls: "body" }, d.body)),
      state,
      h("div", { cls: "row-l" }, send, h("button", { onclick: () => composeView(sh, d) }, "← Edit")));
  };

  sh.pane.replaceChildren(
    h("h2", {}, d.replyToId ? "Reply" : "New message"),
    field("To", to), field("Cc", cc), field("Subject", subject), field("Message", body), err,
    h("div", { cls: "row-l" },
      h("button", { cls: "pri", onclick: review }, "Review & send"),
      h("button", { onclick: () => { if (!(d.to || d.body) || confirm("Discard this message?")) sh.showList(); } }, "Discard")),
    h("p", { cls: "mut small" }, "Drafts are not saved. Closing or refreshing this page discards the message."));
  (d.replyToId ? body : to).focus();
  if (d.replyToId) (body as HTMLTextAreaElement).setSelectionRange(0, 0);
}
