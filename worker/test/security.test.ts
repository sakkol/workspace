import { describe, expect, it } from "vitest";
import { b64u, fromB64, ipKey, makeSealer, timingSafeEqual, uaLabel } from "../src/security";
import { bodyText } from "../src/gmail";

describe("security helpers", () => {
  it("ipKey keys IPv4 whole and IPv6 by /64", () => {
    expect(ipKey("203.0.113.9")).toBe("203.0.113.9");
    expect(ipKey("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe("2001:db8:1:2");
    expect(ipKey("2001:db8:1:2::1")).toBe("2001:db8:1:2");
    expect(ipKey("2001:db8::1")).toBe("2001:db8:0:0");
    expect(ipKey("::1")).toBe("0:0:0:0");
  });
  it("timingSafeEqual", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
  });
  it("b64u handles large inputs and round-trips", () => {
    const big = new Uint8Array(300_000).map((_, i) => i % 251);
    expect(fromB64(b64u(big))).toEqual(big);
  });
  it("uaLabel", () => {
    expect(uaLabel("Mozilla/5.0 (Windows NT 10.0) Chrome/120 Safari/537")).toBe("Chrome on Windows");
    expect(uaLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 17) Safari/605")).toBe("Safari on iOS");
  });
});

describe("token sealing (F10)", () => {
  const key = b64u(crypto.getRandomValues(new Uint8Array(32)));
  it("round-trips and binds to the record key", async () => {
    const s = await makeSealer(key);
    const c = await s.seal("ya29.secret", "s:abc");
    expect(c).not.toContain("ya29");
    expect(await s.open(c, "s:abc")).toBe("ya29.secret");
    await expect(s.open(c, "s:other")).rejects.toThrow();
  });
  it("accepts standard base64 keys (openssl rand -base64 32) and rejects short keys", async () => {
    const std = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
    await expect(makeSealer(std)).resolves.toBeTruthy();
    await expect(makeSealer("c2hvcnQ=")).rejects.toThrow();
  });
  it("uses a fresh IV each time", async () => {
    const s = await makeSealer(key);
    expect(await s.seal("x", "a")).not.toBe(await s.seal("x", "a"));
  });
});

describe("gmail body extraction", () => {
  const enc = (s: string) => b64u(new TextEncoder().encode(s));
  it("prefers text/plain and ignores attachments", () => {
    const p = { mimeType: "multipart/mixed", parts: [
      { mimeType: "text/plain", filename: "notes.txt", body: { data: enc("ATTACHMENT") } },
      { mimeType: "text/plain", filename: "", body: { data: enc("real body") } },
    ] };
    expect(bodyText(p)).toBe("real body");
  });
  it("reduces HTML to inert text (no tags survive)", () => {
    const html = '<p>Hi<script>alert(1)</script><img src=x onerror=alert(2)></p><b>bold</b>';
    const out = bodyText({ mimeType: "text/html", body: { data: enc(html) } });
    expect(out).not.toMatch(/[<>]/);
    expect(out).not.toContain("alert(1)");
  });
});
