const enc = new TextEncoder();

/** base64url without padding. Chunked so large inputs do not overflow the call stack. */
export const b64u = (b: ArrayBuffer | Uint8Array): string => {
  const u = b instanceof Uint8Array ? b : new Uint8Array(b);
  let s = "";
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/** Decode base64 or base64url (padding optional). */
export const fromB64 = (s: string): Uint8Array<ArrayBuffer> => {
  const t = s.replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, "");
  const bin = atob(t + "=".repeat((4 - (t.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

export const rnd = (n: number) => b64u(crypto.getRandomValues(new Uint8Array(n)));
export const sha = async (s: string) => b64u(await crypto.subtle.digest("SHA-256", enc.encode(s)));

/** Constant-time string comparison (length is not secret here). */
export const timingSafeEqual = (a: string, b: string): boolean => {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
};

/** Rate-limit key: a whole IPv4 address, or the /64 of an IPv6 address (one home = one /64). */
export const ipKey = (ip: string): string => {
  if (!ip.includes(":")) return ip;
  const [head, tail] = ip.split("::");
  const a = head ? head.split(":") : [];
  const b = tail ? tail.split(":") : [];
  const full = [...a, ...Array(Math.max(0, 8 - a.length - b.length)).fill("0"), ...b];
  return full.slice(0, 4).join(":");
};

/** Cosmetic label for the phone confirmation screen ("Chrome on Windows"). Not a security signal. */
export const uaLabel = (ua: string): string => {
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox"
    : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Unknown browser";
  const os = /Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS"
    : /Mac OS X/.test(ua) ? "macOS" : /CrOS/.test(ua) ? "ChromeOS" : /Linux/.test(ua) ? "Linux" : "unknown OS";
  return `${browser} on ${os}`;
};

/** AES-GCM encryption of provider tokens stored in the Durable Object. `aad` binds a ciphertext to its record key. */
export async function makeSealer(keyB64: string) {
  const raw = fromB64(keyB64);
  if (raw.length !== 32) throw new Error("TOKEN_KEY must be 32 bytes (base64)");
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
  return {
    async seal(plain: string, aad: string): Promise<string> {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(aad) }, key, enc.encode(plain));
      return b64u(iv) + "." + b64u(ct);
    },
    async open(sealed: string, aad: string): Promise<string> {
      const [iv, ct] = sealed.split(".");
      if (!iv || !ct) throw new Error("bad_ciphertext");
      const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(iv), additionalData: enc.encode(aad) }, key, fromB64(ct));
      return new TextDecoder().decode(pt);
    },
  };
}
