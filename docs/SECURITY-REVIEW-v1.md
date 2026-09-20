# Sakkol Workspace v1 — Security Review

Reviewed: `worker/src/index.ts`, `web/src/main.ts`, `web/index.html`, `worker/wrangler.toml`, `.github/workflows/deploy.yml`, `README.md`, against the v1.2 spec.
Method: manual code read. Nothing was executed or penetration-tested, so treat this as a code review, not an audit.

**Bottom line:** the architecture is sound and most of the spec is implemented correctly. There are **two High-severity issues, both in the linking flow**, and both are cheap to fix. Fix them before adding write access to Gmail, because v2 raises the damage an attacker can do from "read mail" to "send mail as you".

I found no committed secrets. The client ID and Worker subdomain in `wrangler.toml` are public identifiers, not secrets. `GOOGLE_CLIENT_SECRET` is correctly kept out of the repo.

---

## Summary

| # | Severity | Finding | Where |
|---|----------|---------|-------|
| F1 | **High** | `/link/claim` and `/link/status` need only the transaction ID, which is displayed in the QR code. Anyone who sees the QR can steal the session. | `index.ts` 52-73, 152-159 |
| F2 | **High** | The "verification code" is handed to anyone with the ID and confirmed by tapping Yes. It does not stop remote phishing or blind tapping. | `index.ts` 43, 160-165; `main.ts` 108-115 |
| F3 | Medium | Frontend can be framed (GitHub Pages cannot send `frame-ancestors`; meta CSP ignores it). Spec §16 requires it. | `index.html` |
| F4 | Medium | Rate limiting is per IP with weak keys, runs a storage write on every request (including 2 s polling), and all of it funnels through one Durable Object. Easy to bypass or exhaust. | `index.ts` 82-88, 130, 143-144 |
| F5 | Medium | Google `scope` and `expires_in` in the token response are never checked. Fine for one scope today; breaks the moment scopes differ or granular consent is used. | `index.ts` 187-190 |
| F6 | Low | Done/expiry deletes the token from the Relay but never revokes it at Google. It stays valid at Google for up to ~1 h. | `index.ts` 81, 89-96 |
| F7 | Low | Error path in the OAuth callback can strand a transaction and show raw JSON on the phone. | `index.ts` 182-192, 227 |
| F8 | Low | `web/` has no lockfile; the workflow uses `npm install`; Actions are pinned by tag, not commit SHA. | `deploy.yml`, `web/` |
| F9 | Low | Attacker with a transaction ID can burn it (`cancel`) before the real user. Availability only. | `index.ts` 62-65, 160-163 |
| F10 | Info | Tokens are stored as plaintext in Durable Object storage (encrypted at rest by Cloudflare, but spec §8 says "encrypted/securely stored"). | `index.ts` 59, 69 |

---

## F1 — Unauthenticated claim (High)

**What happens today.** The QR code encodes `#/p/<txId>`. When the phone finishes Google OAuth, the transaction becomes `approved`. `POST /link/claim/<txId>` then returns the capability to *whoever calls it first*. The only "protection" is the `Origin` header check (`index.ts` line 142), but `Origin` is set by browsers and trivially forged by `curl`. CORS is not authentication.

**Who can exploit it.** Anyone who learns the transaction ID during its 2.5-minute life: someone photographing the QR on a public screen, a screen-share viewer, a malicious extension in another tab, or the phone's browser history. The legitimate browser polls every 2 s. An attacker can poll faster (the limiter allows 90 status calls/min per IP, so about 1.5/s, and IPs are cheap), so they win the race often. The result is a 30-minute Gmail session in the attacker's hands.

**Fix: add a claim secret that never leaves the shared browser.**
1. The browser generates 32 random bytes and sends only `sha256(secret)` in `POST /link/start`.
2. The Relay stores the hash in the transaction.
3. `status` and `claim` require the secret in an `X-Claim-Secret` header; the Relay hashes it and compares.
4. The secret is never in the QR code or the phone URL, so seeing the QR is not enough.

This is PKCE for the browser leg. Full code is in `README-v2.md`, Phase 0.

This also fixes the "attacker completes the flow with their own Google account and feeds you a fake inbox" variant, because only the original browser can claim.

---

## F2 — Verification code does not verify anything (High)

**Problems.**
- `/link/info` returns the code to anyone who has the transaction ID.
- The phone shows the code and asks "does it match?" with a Yes button. A user can tap Yes without looking. Attackers rely on exactly this.
- **Remote phishing (device-code phishing).** An attacker starts a transaction on *their own* machine and sends the victim the QR/link ("scan to see the photos", "IT needs you to verify"). The victim's phone shows the same code the attacker's screen shows. If the victim taps Yes and approves Google, the attacker's browser receives the victim's Gmail. Nothing on the phone tells the victim the request came from a stranger's computer.

**Fix.**
1. Reverse the direction: the phone shows an **input**, the user **types** the 6-digit code from the computer screen. Tapping through is impossible.
2. The Relay stops returning the code from `/link/info`.
3. Limit to 3 attempts, then cancel the transaction.
4. Show context on the phone: which app is being unlocked, what access it grants, the requesting computer's approximate location and browser (from Cloudflare's `request.cf`), and the age of the request. Add the sentence: *"Only continue if you are sitting at this computer right now."*

**Honest limit.** If an attacker socially engineers the victim into reading the code aloud, typing it still works. This raises the bar a lot; it does not remove the human factor. Google's own consent page still names Sakkol, so also keep the phone-side warning prominent.

---

## F3 — Framing / clickjacking (Medium)

GitHub Pages cannot set response headers, and `frame-ancestors` is ignored in a `<meta>` CSP. Spec §16 ("must not be frameable") is therefore not met.

Mitigations, cheapest first:
- Add a frame-buster at the top of `main.ts`: if `window.top !== window.self`, replace the page with a blank message and stop.
- Better: host the frontend on **Cloudflare Pages** and add a `_headers` file with `Content-Security-Policy: frame-ancestors 'none'` and `X-Frame-Options: DENY`. Cloudflare Pages does not set cookies by default. Document this under spec §19 if you move.

Once F2's typed-code fix is in, the confirm step is no longer a single clickable button, which shrinks the clickjacking payoff.

---

## F4 — Rate limiting and the single Durable Object (Medium)

- **IPv6 rotation.** The key is the full `cf-connecting-ip`. A single IPv6 /64 gives an attacker effectively unlimited "IPs". Key on the /64.
- **Shared NAT.** Public computers often share one IP. One user hammering the endpoints locks out everyone at that venue. Acceptable for a personal tool, but be aware.
- **Every request writes storage.** `hit()` does `storage.put` on each call, including the 2 s status polling and every Gmail call. All traffic goes through one Durable Object named `"main"` (line 130). That is a throughput and cost ceiling and an easy target.
- **Unbounded pending transactions.** Nothing caps how many transactions exist at once, and `alarm()` does a full `storage.list()` every 30 s.

Fixes: /64 keying; a global cap on pending transactions (for example 100); keep rate-limit counters in the Durable Object's memory instead of storage (a reset on eviction is harmless for limiting); or use Cloudflare's rate-limiting binding for the cheap per-IP limits.

---

## F5 — Token response not validated (Medium)

The callback accepts `j.access_token` and ignores `scope` and `expires_in`.
- With Google's granular consent, a user can uncheck scopes on the consent screen. You must verify the granted `scope` covers what you need. This matters a lot in v2 when scopes differ between read-only and read/write.
- Session lifetime should be `min(configured max, expires_in − 60 s)`, not a hard-coded 30 minutes that merely happens to be shorter today. Spotify tokens last ~1 h; a future provider may be shorter.

---

## F6 — No provider-side revocation (Low)

"Done" deletes the Relay's copy. The token is still valid at Google until it expires. Call Google's revoke endpoint (`https://oauth2.googleapis.com/revoke`) on Done and on expiry (best effort, in the background). Revoking tends to also remove the app from the account's connected-apps list when no other tokens remain; check that behaviour on your own account. Spotify has no token-revoke endpoint, so for Spotify the user removes the grant at spotify.com/account/apps.

---

## F7 — OAuth callback error handling (Low)

`takeState` moves the transaction to `exchanging` *before* the fetch to Google. If that fetch or `r.json()` throws, the outer `catch` returns a JSON 500 to the *phone's* browser and the transaction is stuck in `exchanging` until it expires. Wrap the exchange in its own `try/catch`, call `fail()`, and redirect to the phone error page.

---

## F8 — Supply chain (Low)

- `worker/` has a `package-lock.json`; `web/` does not.
- The workflow runs `npm install`, which can drift. Use `npm ci` with a committed lockfile.
- `actions/checkout@v4` etc. are pinned by tag. Pin by commit SHA and enable Dependabot.

The `qrcode` package is bundled into the page that will later hold Gmail and Spotify capabilities, so its provenance matters. Your `script-src 'self'` CSP limits the blast radius of a compromised dependency, but does not remove it.

---

## F9 — Transaction burning (Low)

`cancel` needs only the ID. With F1 fixed, an attacker can still cancel someone's transaction if they saw the QR. That is a nuisance, not a breach. You can require the claim secret for cancel as well when called from the computer.

---

## F10 — Plaintext tokens at rest (Info)

Durable Object storage is encrypted at rest by Cloudflare, so this is defensible. If you want to meet the spec wording literally, wrap tokens with AES-GCM using a Worker secret (`TOKEN_KEY`) before `put()`. Low value, small effort.

---

## What v1 gets right

- PKCE (S256), and a per-transaction `state` that is single-use.
- A transaction state machine enforced inside one Durable Object, so single-use guarantees are atomic.
- The capability is 256-bit random and only its SHA-256 is stored.
- Capability lives only in a JS variable; `credentials: "omit"`; `Cache-Control: no-store`.
- Gmail content is rendered with `textContent` / `<pre>`, never as HTML, so email content cannot run script.
- Message IDs are validated by `[\w-]+` before being placed into Gmail API paths, so there is no path injection.
- Sensible default headers on Relay responses (`nosniff`, `no-referrer`, CSP `default-src 'none'`, HSTS).
- No sensitive values are logged.
- No `access_type=offline`; an unexpected refresh token is discarded and logged as an event.

---

## New risks that v2 introduces (design these in from the start)

| Risk | Why it is new | Mitigation in `README-v2.md` |
|------|---------------|------------------------------|
| **Send-as-you** | With `gmail.modify`, a stolen capability can send mail and trash mail, not just read it. | Read-only unlock option; server-side send caps (recipients, count per session, size); no Bcc, attachments, forwarding or settings; explicit review-and-send step |
| **Header injection** | Composing mail means building MIME. CR/LF in a `To` or `Subject` can add Bcc headers or forge messages. | Relay builds MIME from structured fields, rejects CR/LF, and takes reply headers from Gmail, never from the browser |
| **Cross-app token leakage** | One browser now holds capabilities for several apps. | One capability per app, bound to that app; a Gmail capability is rejected on `/spotify/*` and vice versa |
| **Google incremental auth** | `include_granted_scopes=true` would merge the Gmail and (future) Drive grants into one token. | Never set it; documented as a hard rule |
| **Third-party script in the page** | Spotify's Web Playback SDK is JavaScript from `sdk.scdn.co` and needs a Spotify token in the browser. Loaded into the same page it could read the Gmail capability in memory. | v2 uses Spotify Connect *remote control* through the Relay. The SDK is explicitly out of scope until it can run in a separate origin |
| **Longer-lived sessions** | Music control wants sessions longer than 5 idle minutes. | Per-app idle/max limits; background polling does not extend the idle timer |
| **Display-name spoofing** | Now that you can reply, misleading `From:` names matter. | Always show the raw address; do not auto-link URLs |
| **Spotify limits** | Dev-mode apps are capped at 5 users and require the owner to have Premium. | Documented; fine for personal use |

---

## Fix order

1. F1 claim secret
2. F2 typed code + context
3. F5 scope / `expires_in` validation
4. F7 callback error handling
5. F4 limiter changes
6. F6 provider revoke
7. F3 frame-buster
8. F8 lockfile + `npm ci`

All of these are specified with code in `README-v2.md`, Phase 0. Steps 1-4 are about 100 lines total.
