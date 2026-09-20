// The browser sends structured fields only. The Relay builds the MIME message, so CR/LF in a field can never
// smuggle extra headers (Bcc:, From:, ...) into an outgoing email.
import { Bad } from "./errors";
import { b64u } from "./security";

export const LIMITS = { rcpt: 10, subject: 150, body: 50_000 };

const ADDR = /^[^\s<>"',;()\[\]\\@]+@[^\s<>"',;()\[\]\\@]+\.[^\s<>"',;()\[\]\\@]+$/;
const enc = new TextEncoder();

export const noCtl = (s: string) => {
  if (/[\r\n\0]/.test(s)) throw new Bad("header_injection");
  return s;
};

export function addrs(v: unknown, code = "bad_recipient"): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new Bad(code);
  return v.map((x) => {
    if (typeof x !== "string") throw new Bad(code);
    const a = noCtl(x.trim());
    if (a.length > 254 || !ADDR.test(a)) throw new Bad(code);
    return a;
  });
}

const utf8b64 = (s: string) => {
  const u = enc.encode(s);
  let bin = "";
  for (let i = 0; i < u.length; i += 0x8000) bin += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(bin);
};
const wrap76 = (s: string) => s.replace(/.{1,76}/g, "$&\r\n");

/** RFC 2047 encoded-words, each <= 45 bytes of UTF-8 (so <= 75 chars encoded), folded with CRLF + space. */
export function encodeSubject(subject: string): string {
  const words: string[] = [];
  let cur = "", curBytes = 0;
  for (const ch of subject) {
    const n = enc.encode(ch).length;
    if (curBytes + n > 45) { words.push(cur); cur = ""; curBytes = 0; }
    cur += ch; curBytes += n;
  }
  if (cur || !words.length) words.push(cur);
  return words.map((w) => `=?UTF-8?B?${utf8b64(w)}?=`).join("\r\n ");
}

export interface Outgoing { to: string[]; cc: string[]; subject: string; body: string; inReplyTo?: string; references?: string }

export function parseOutgoing(b: Record<string, unknown>): Outgoing {
  const to = addrs(b.to), cc = addrs(b.cc);
  if (to.length + cc.length < 1) throw new Bad("no_recipient");
  if (to.length + cc.length > LIMITS.rcpt) throw new Bad("too_many_recipients");
  const subject = typeof b.subject === "string" ? b.subject : "";
  const body = typeof b.body === "string" ? b.body : "";
  if (subject.length > LIMITS.subject) throw new Bad("subject_too_long");
  if (body.length > LIMITS.body) throw new Bad("body_too_long");
  noCtl(subject);
  return { to, cc, subject, body };
}

export function buildRaw(m: Outgoing): string {
  const h = [
    `To: ${m.to.join(", ")}`,
    m.cc.length ? `Cc: ${m.cc.join(", ")}` : "",
    `Subject: ${encodeSubject(noCtl(m.subject))}`,
    m.inReplyTo ? `In-Reply-To: ${noCtl(m.inReplyTo)}` : "",
    m.references ? `References: ${noCtl(m.references)}` : "",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
  ].filter(Boolean);
  // Body newlines are inside the base64 payload, so they cannot create headers.
  return b64u(enc.encode(h.join("\r\n") + "\r\n\r\n" + wrap76(utf8b64(m.body))));
}
