import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { b64u, sha256Fallback } from "../src/core/crypto";

const ref = (b: Uint8Array) => new Uint8Array(createHash("sha256").update(b).digest());

describe("pure-JS SHA-256 fallback (used on http:// LAN staging where crypto.subtle is unavailable)", () => {
  it("matches the standard test vector", () => {
    const hex = [...sha256Fallback(new TextEncoder().encode("abc"))].map((x) => x.toString(16).padStart(2, "0")).join("");
    expect(hex).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
  it("matches Node's sha256 for many lengths (block boundaries included)", () => {
    for (const n of [0, 1, 55, 56, 63, 64, 65, 119, 120, 128, 1000]) {
      const b = new Uint8Array(randomBytes(n));
      expect(sha256Fallback(b)).toEqual(ref(b));
    }
  });
  it("b64u is url-safe and unpadded", () => {
    expect(b64u(new Uint8Array([251, 255, 254]))).toBe("-__-");
  });
});
