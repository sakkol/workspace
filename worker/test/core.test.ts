import { describe, expect, it } from "vitest";
import { approvedTx, CTX, newSecret, setup } from "./helpers";
import { CODE_TRIES, MAX_PENDING, MAX_SENDS, TX_TTL } from "../src/core";

describe("link transaction", () => {
  it("rejects bad app / access / claim hash", async () => {
    const s = setup(); const { hash } = await newSecret();
    expect(await s.core.newTx("nope", "read", hash, CTX)).toEqual({ error: "bad_request" });
    expect(await s.core.newTx("constructor", "read", hash, CTX)).toEqual({ error: "bad_request" });
    expect(await s.core.newTx("gmail", "admin", hash, CTX)).toEqual({ error: "bad_request" });
    expect(await s.core.newTx("spotify", "read", hash, CTX)).toEqual({ error: "bad_request" }); // spotify has no read level
    expect(await s.core.newTx("gmail", "read", "short", CTX)).toEqual({ error: "bad_request" });
  });

  it("claim needs the claim secret (F1)", async () => {
    const s = setup(); const a = await approvedTx(s);
    expect(a.res).toBe("ok");
    expect(await s.core.claim(a.id, "")).toBeNull();
    expect(await s.core.claim(a.id, "wrong-secret")).toBeNull();
    expect(await s.core.status(a.id, "wrong-secret")).toBe("expired");
    expect(await s.core.status(a.id, a.secret)).toBe("approved");
    expect(await s.core.claim(a.id, a.secret)).not.toBeNull();
  });

  it("claim is single-use", async () => {
    const s = setup(); const a = await approvedTx(s);
    expect(await s.core.claim(a.id, a.secret)).not.toBeNull();
    expect(await s.core.claim(a.id, a.secret)).toBeNull();
  });

  it("info() never exposes the verification code (F2)", async () => {
    const s = setup(); const { hash } = await newSecret();
    const tx: any = await s.core.newTx("gmail", "write", hash, CTX);
    const info = await s.core.info(tx.id);
    expect(JSON.stringify(info)).not.toContain(tx.code);
    expect(info).toMatchObject({ app: "gmail", access: "write", ctx: CTX });
  });

  it("wrong code x3 locks the transaction, even for the right code afterwards (F2)", async () => {
    const s = setup(); const { hash } = await newSecret();
    const tx: any = await s.core.newTx("gmail", "read", hash, CTX);
    const wrong = tx.code === "000000" ? "111111" : "000000";
    for (let i = 1; i < CODE_TRIES; i++) expect(await s.core.confirm(tx.id, wrong)).toMatchObject({ error: "wrong_code", left: CODE_TRIES - i });
    expect(await s.core.confirm(tx.id, wrong)).toEqual({ error: "locked" });
    expect(await s.core.confirm(tx.id, tx.code)).toEqual({ error: "expired" });
  });

  it("code must be six digits", async () => {
    const s = setup(); const { hash } = await newSecret();
    const tx: any = await s.core.newTx("gmail", "read", hash, CTX);
    expect(await s.core.confirm(tx.id, 123456)).toMatchObject({ error: "wrong_code" });
    expect(await s.core.confirm(tx.id, tx.code + "0")).toMatchObject({ error: "wrong_code" });
  });

  it("oauth begin requires the nonce from a correct confirm", async () => {
    const s = setup(); const { hash } = await newSecret();
    const tx: any = await s.core.newTx("gmail", "read", hash, CTX);
    expect(await s.core.begin(tx.id, "anything")).toBeNull(); // not confirmed yet
    const c: any = await s.core.confirm(tx.id, tx.code);
    expect(await s.core.begin(tx.id, "wrong")).toBeNull();
    expect(await s.core.begin(tx.id, c.nonce)).toMatchObject({ vendor: "google", app: "gmail" });
    expect(await s.core.begin(tx.id, c.nonce)).toBeNull(); // nonce is single-use
  });

  it("state is single-use and must match", async () => {
    const s = setup(); const { hash } = await newSecret();
    const tx: any = await s.core.newTx("gmail", "read", hash, CTX);
    const c: any = await s.core.confirm(tx.id, tx.code);
    const b: any = await s.core.begin(tx.id, c.nonce);
    expect(await s.core.takeState(tx.id + ".forged")).toBeNull();
    expect(await s.core.takeState("garbage")).toBeNull();
    expect(await s.core.takeState(b.state)).not.toBeNull();
    expect(await s.core.takeState(b.state)).toBeNull();
  });

  it("expires after the TTL", async () => {
    const s = setup(); const a = await approvedTx(s);
    s.clock.t += TX_TTL + 1;
    expect(await s.core.status(a.id, a.secret)).toBe("expired");
    expect(await s.core.claim(a.id, a.secret)).toBeNull();
  });

  it("caps pending transactions", async () => {
    const s = setup(); const { hash } = await newSecret();
    for (let i = 0; i < MAX_PENDING; i++) await s.core.newTx("gmail", "read", hash, CTX);
    expect(await s.core.newTx("gmail", "read", hash, CTX)).toEqual({ error: "busy" });
  });

  it("computer-side cancel needs the secret; phone-side decline does not", async () => {
    const s = setup(); const { secret, hash } = await newSecret();
    const tx: any = await s.core.newTx("gmail", "read", hash, CTX);
    await s.core.cancel(tx.id, "wrong");
    expect(await s.core.status(tx.id, secret)).toBe("pending");
    await s.core.cancel(tx.id, secret);
    expect(await s.core.status(tx.id, secret)).toBe("cancelled");
  });

  it("rejects an approval whose granted scope is missing (F5) and revokes that token", async () => {
    const s = setup();
    const a = await approvedTx(s, "gmail", "write", "https://www.googleapis.com/auth/gmail.readonly");
    expect(a.res).toBe("scope");
    expect(await s.core.claim(a.id, a.secret)).toBeNull();
    expect(s.revoked).toHaveLength(1);
  });

  it("never stores the token in plaintext", async () => {
    const s = setup(); const a = await approvedTx(s);
    const raw = JSON.stringify([...s.kv.m]);
    expect(raw).not.toContain('"TOKEN-gmail"');
    await s.core.claim(a.id, a.secret);
    expect(JSON.stringify([...s.kv.m])).not.toContain('"TOKEN-gmail"');
  });
});

describe("sessions", () => {
  it("lifetime = min(app max, token life - 60s) (F5)", async () => {
    const s = setup();
    const a = await approvedTx(s, "gmail");
    expect((await s.core.claim(a.id, a.secret))!.ttlMs).toBe(30 * 60_000);
    // short-lived vendor token
    const { secret, hash } = await newSecret();
    const tx: any = await s.core.newTx("gmail", "read", hash, CTX);
    const c: any = await s.core.confirm(tx.id, tx.code);
    const b: any = await s.core.begin(tx.id, c.nonce);
    const st: any = await s.core.takeState(b.state);
    await s.core.approve(st.id, { token: "T", tokenLifeMs: 600_000, scope: "https://www.googleapis.com/auth/gmail.readonly" });
    expect((await s.core.claim(tx.id, secret))!.ttlMs).toBe(540_000);
  });

  it("hard expiry", async () => {
    const s = setup(); const a = await approvedTx(s);
    const { cap } = (await s.core.claim(a.id, a.secret))!;
    for (let i = 0; i < 7; i++) { s.clock.t += 4 * 60_000; expect(await s.core.auth(cap, "gmail")).not.toBeNull(); } // active, 28 min
    s.clock.t += 3 * 60_000; // 31 min
    expect(await s.core.auth(cap, "gmail")).toBeNull();
  });

  it("idle expiry and vendor revocation on expiry (F6)", async () => {
    const s = setup(); const a = await approvedTx(s);
    const { cap } = (await s.core.claim(a.id, a.secret))!;
    s.clock.t += 5 * 60_000 + 1;
    expect(await s.core.auth(cap, "gmail")).toBeNull();
    expect(s.revoked).toEqual([{ app: "gmail", token: "TOKEN-gmail" }]);
  });

  it("a capability only works for its own app", async () => {
    const s = setup(); const a = await approvedTx(s, "gmail");
    const { cap } = (await s.core.claim(a.id, a.secret))!;
    expect(await s.core.auth(cap, "spotify")).toBeNull();
    expect(await s.core.auth(cap, "gmail")).toMatchObject({ token: "TOKEN-gmail", access: "read" });
  });

  it("two apps have independent sessions", async () => {
    const s = setup();
    const g = await approvedTx(s, "gmail"); const sp = await approvedTx(s, "spotify", "write");
    const gc = (await s.core.claim(g.id, g.secret))!, sc = (await s.core.claim(sp.id, sp.secret))!;
    await s.core.revoke(gc.cap);
    expect(await s.core.auth(gc.cap, "gmail")).toBeNull();
    expect(await s.core.auth(sc.cap, "spotify")).toMatchObject({ token: "TOKEN-spotify" });
    expect(s.revoked).toEqual([{ app: "gmail", token: "TOKEN-gmail" }]);
  });

  it("passive polling does not extend the idle timer", async () => {
    const s = setup(); const a = await approvedTx(s, "spotify", "write");
    const { cap } = (await s.core.claim(a.id, a.secret))!;
    for (let i = 0; i < 3; i++) { s.clock.t += 5 * 60_000; expect(await s.core.auth(cap, "spotify", false)).not.toBeNull(); } // 15 min of polling: still inside idle
    s.clock.t += 1; // 15 min + 1 ms since the last human activity, despite constant polling
    expect(await s.core.auth(cap, "spotify", false)).toBeNull();
  });

  it("touching extends idle", async () => {
    const s = setup(); const a = await approvedTx(s);
    const { cap } = (await s.core.claim(a.id, a.secret))!;
    for (let i = 0; i < 5; i++) { s.clock.t += 4 * 60_000; expect(await s.core.auth(cap, "gmail")).not.toBeNull(); }
  });

  it("revoke deletes the session", async () => {
    const s = setup(); const a = await approvedTx(s);
    const { cap } = (await s.core.claim(a.id, a.secret))!;
    await s.core.revoke(cap);
    expect(await s.core.auth(cap, "gmail")).toBeNull();
  });

  it("send slots: write sessions only, capped per session", async () => {
    const s = setup();
    const r = await approvedTx(s, "gmail", "read"); const rc = (await s.core.claim(r.id, r.secret))!;
    expect(await s.core.sendSlot(rc.cap)).toMatchObject({ ok: false });
    const w = await approvedTx(s, "gmail", "write"); const wc = (await s.core.claim(w.id, w.secret))!;
    for (let i = 0; i < MAX_SENDS; i++) expect(await s.core.sendSlot(wc.cap)).toMatchObject({ ok: true });
    expect(await s.core.sendSlot(wc.cap)).toEqual({ ok: false, reason: "send_limit" });
  });

  it("alarm removes expired transactions/sessions, revokes at vendor, and drops v1 records", async () => {
    const s = setup(); const a = await approvedTx(s);
    await s.core.claim(a.id, a.secret);
    await s.kv.put("s:old", { provider: "google", token: "plain", created: 1, last: 1 }); // v1 session
    await s.kv.put("r:old", { n: 1, reset: 1 }); // v1 rate-limit key
    s.clock.t += 31 * 60_000;
    await s.core.alarm();
    expect(s.kv.m.size).toBe(0);
    expect(s.revoked).toEqual([{ app: "gmail", token: "TOKEN-gmail" }]);
  });
});

describe("rate limiting", () => {
  it("limits per window and resets", () => {
    const s = setup();
    for (let i = 0; i < 3; i++) expect(s.core.hit("k", 3, 60_000)).toBe(true);
    expect(s.core.hit("k", 3, 60_000)).toBe(false);
    expect(s.core.hit("other", 3, 60_000)).toBe(true);
    s.clock.t += 60_001;
    expect(s.core.hit("k", 3, 60_000)).toBe(true);
  });
});

describe("stream (web player) transactions", () => {
  const STREAM_SCOPE = "streaming user-read-email user-read-private user-read-playback-state user-modify-playback-state";
  it("claimToken returns the token once, needs the claim secret, and leaves no session or token behind", async () => {
    const s = setup(); const a = await approvedTx(s, "spotify", "stream", STREAM_SCOPE);
    expect(a.res).toBe("ok");
    expect(await s.core.claimToken(a.id, "wrong")).toBeNull();
    const r = await s.core.claimToken(a.id, a.secret);
    expect(r).toMatchObject({ token: "TOKEN-spotify", app: "spotify", access: "stream", ttlMs: 3_540_000 });
    expect(await s.core.claimToken(a.id, a.secret)).toBeNull();
    expect([...s.kv.m.keys()].some((k) => k.startsWith("s:"))).toBe(false);
    expect(JSON.stringify([...s.kv.m])).not.toContain("TOKEN-spotify");
  });
  it("a stream transaction cannot be claimed as a normal capability, and vice versa", async () => {
    const s = setup();
    const a = await approvedTx(s, "spotify", "stream", STREAM_SCOPE);
    expect(await s.core.claim(a.id, a.secret)).toBeNull();
    const g = await approvedTx(s, "gmail", "read");
    expect(await s.core.claimToken(g.id, g.secret)).toBeNull();
  });
  it("requires every stream scope", async () => {
    const s = setup();
    const a = await approvedTx(s, "spotify", "stream", "user-read-email user-read-private");
    expect(a.res).toBe("scope");
    expect(await s.core.claimToken(a.id, a.secret)).toBeNull();
  });
  it("gmail has no stream level and info() labels the web player", async () => {
    const s = setup(); const { hash } = await newSecret();
    expect(await s.core.newTx("gmail", "stream", hash, CTX)).toEqual({ error: "bad_request" });
    const tx: any = await s.core.newTx("spotify", "stream", hash, CTX);
    expect(await s.core.info(tx.id)).toMatchObject({ label: "Spotify web player", access: "stream" });
  });
});

