// The claim secret is hashed in the browser. crypto.subtle only exists in secure contexts (https / localhost), so the
// LAN-IP staging setup (http://192.168.x.x) needs a pure-JS SHA-256 fallback. Tested against Node's crypto in test/.

export const b64u = (u: Uint8Array): string => {
  let s = "";
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
export const randomB64u = (n: number) => b64u(crypto.getRandomValues(new Uint8Array(n)));

const primes = (n: number) => { const p: number[] = []; for (let i = 2; p.length < n; i++) if (p.every((q) => i % q)) p.push(i); return p; };
const frac32 = (x: number) => Math.floor((x - Math.floor(x)) * 2 ** 32) >>> 0;

export function sha256Fallback(msg: Uint8Array): Uint8Array {
  const P = primes(64);
  const K = P.map((p) => frac32(Math.cbrt(p)));
  const H = primes(8).map((p) => frac32(Math.sqrt(p)));
  const len = msg.length, padded = new Uint8Array(((len + 9 + 63) >> 6) << 6);
  padded.set(msg); padded[len] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, Math.floor((len * 8) / 2 ** 32)); dv.setUint32(padded.length - 4, (len * 8) >>> 0);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let o = 0; o < padded.length; o += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(o + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = H;
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + hh) >>> 0;
  }
  const out = new Uint8Array(32), ov = new DataView(out.buffer);
  H.forEach((x, i) => ov.setUint32(i * 4, x));
  return out;
}

export async function sha256b64u(s: string): Promise<string> {
  const data = new TextEncoder().encode(s);
  if (globalThis.crypto?.subtle) return b64u(new Uint8Array(await crypto.subtle.digest("SHA-256", data)));
  return b64u(sha256Fallback(data));
}
