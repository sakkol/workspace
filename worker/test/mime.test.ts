import { describe, expect, it } from "vitest";
import { addrs, buildRaw, encodeSubject, LIMITS, parseOutgoing } from "../src/mime";
import { fromB64 } from "../src/security";

const decode = (raw: string) => new TextDecoder().decode(fromB64(raw));
const bodyOf = (mime: string) => mime.split("\r\n\r\n")[1];

describe("outgoing mail", () => {
  it("accepts normal addresses", () => {
    expect(addrs(["a@b.com", " c.d+e@f.co.uk "])).toEqual(["a@b.com", "c.d+e@f.co.uk"]);
  });
  it.each([
    "a@b.com\r\nBcc: x@y.com", "a@b.com\nBcc: x@y.com", "not-an-address", "a@b", "<a@b.com>", "a@b.com, c@d.com", '"x"@y.com', "a@b.com\0",
  ])("rejects %j", (bad) => {
    expect(() => addrs([bad])).toThrow();
  });
  it("rejects header injection in the subject", () => {
    expect(() => parseOutgoing({ to: ["a@b.com"], subject: "Hi\r\nBcc: x@y.com", body: "x" })).toThrow();
  });
  it("enforces recipient, subject and body limits", () => {
    const many = Array.from({ length: LIMITS.rcpt + 1 }, (_, i) => `u${i}@x.com`);
    expect(() => parseOutgoing({ to: many, subject: "s", body: "b" })).toThrow();
    expect(() => parseOutgoing({ to: [], subject: "s", body: "b" })).toThrow();
    expect(() => parseOutgoing({ to: ["a@b.com"], subject: "x".repeat(LIMITS.subject + 1), body: "b" })).toThrow();
    expect(() => parseOutgoing({ to: ["a@b.com"], subject: "s", body: "x".repeat(LIMITS.body + 1) })).toThrow();
  });
  it("cannot smuggle headers through the body", () => {
    const raw = buildRaw({ to: ["a@b.com"], cc: [], subject: "Hi", body: "line1\r\nBcc: evil@x.com\r\n\r\nmore" });
    const mime = decode(raw);
    const [headers] = mime.split("\r\n\r\n");
    expect(headers).not.toMatch(/evil/);
    expect(headers).toMatch(/^To: a@b\.com\r\n/);
  });
  it("round-trips UTF-8 (Turkish, emoji) in subject and body", () => {
    const subject = "Günaydın şğıöç 🎵 " + "uzun ".repeat(30);
    const body = "Merhaba dünya 🌍\nİkinci satır";
    const mime = decode(buildRaw({ to: ["a@b.com"], cc: [], subject, body }));
    expect(new TextDecoder().decode(fromB64(bodyOf(mime).replace(/\r\n/g, "")))).toBe(body);
    const subj = /Subject: ([\s\S]*?)\r\nMIME-Version/.exec(mime)![1];
    const words = subj.split("\r\n ");
    expect(words.every((w) => /^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/.test(w) && w.length <= 75)).toBe(true);
    expect(words.map((w) => new TextDecoder().decode(fromB64(w.slice(10, -2)))).join("")).toBe(subject);
  });
  it("encodes an empty subject", () => {
    expect(encodeSubject("")).toBe("=?UTF-8?B??=");
  });
  it("adds reply headers only when given, and rejects control chars in them", () => {
    const mime = decode(buildRaw({ to: ["a@b.com"], cc: ["c@d.com"], subject: "Re: x", body: "b", inReplyTo: "<id@x>", references: "<a@x> <id@x>" }));
    expect(mime).toContain("In-Reply-To: <id@x>");
    expect(mime).toContain("Cc: c@d.com");
    expect(() => buildRaw({ to: ["a@b.com"], cc: [], subject: "s", body: "b", inReplyTo: "<id@x>\r\nBcc: e@x.com" })).toThrow();
  });
});
