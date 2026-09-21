# Security architecture (v2)

Threat model, credential rules and the shared-browser guarantee are unchanged from spec v1.2: the shared computer is untrusted; the phone is the trusted authentication device; the Relay is the only security boundary. **v2 adds no new identity system, no cookies, no browser storage, no database.**

## What the shared browser holds
Exactly one artifact per unlocked app: an opaque 256-bit random capability, **in a JavaScript variable**. Sent only as `Authorization: Bearer`. No cookies, localStorage, sessionStorage, IndexedDB. A page refresh discards everything. Each capability is bound to one app: a Gmail capability is rejected by Spotify routes and vice versa.

## What the Relay holds
Provider access tokens, **AES-GCM encrypted** (key `TOKEN_KEY`, bound to the record key) in a Durable Object, only while a session or transaction is live. Client secrets live in Cloudflare secrets. No refresh tokens are ever stored (Spotify returns one by design; it is discarded).

## Findings from the v1 review and their status

| # | Finding | Status | How |
|---|---|---|---|
| F1 | Claim/status needed only the transaction ID | **Fixed** | Claim secret held only by the shared browser; Relay stores its hash; required on status/claim. |
| F2 | Verification code shown to anyone, confirmed by a Yes tap | **Fixed** | Phone must type the code; `/link/info` no longer returns it; 3 tries then lock; phone shows app, access level, browser/city of the requester and a "only if you are at this computer" warning. |
| F3 | Frameable (GitHub Pages sends no headers) | **Mitigated** | JS frame-buster. For real `frame-ancestors` host on Cloudflare Pages (`web/public/_headers` is included). |
| F4 | Weak / expensive rate limiting | **Fixed** | IPv6 keyed by /64; counters in memory (no storage write per request); max 100 pending transactions; cleanup alarm. Residual: users behind one NAT share limits. |
| F5 | Token `scope` / `expires_in` ignored | **Fixed** | All requested scopes must be granted; session lifetime = min(app limit, token life − 60 s). |
| F6 | No revocation at the vendor | **Fixed (Google)** | Google token revoked on DONE, expiry and scope mismatch. Spotify has no revoke API: remove the grant at spotify.com/account/apps. |
| F7 | Callback error path could strand a transaction / show raw JSON | **Fixed** | Exchange wrapped; user is redirected to a friendly error page. |
| F8 | No lockfile / `npm install` in CI | **Fixed** | Lockfiles for `web` and `worker`, `npm ci`, Dependabot, CI. GitHub Actions are pinned by tag, not commit SHA (optional hardening). |
| F9 | Anyone with the QR can cancel a pending transaction | **Accepted** | Availability nuisance only; the person needs to see your screen. |
| F10 | Tokens stored in plaintext | **Fixed** | AES-GCM with `TOKEN_KEY`. |

## New controls for v2
- **Least privilege at unlock:** Gmail *Read only* (default) or *Read & write*. The Relay enforces it from the scopes Google actually granted.
- **Write blast radius:** scope `gmail.modify` only (no permanent delete, no settings so no auto-forward rules). No Bcc, attachments or forwarding. Max 10 recipients, 10 sends per session, 3 sends/minute. Trash, not delete.
- **No header injection:** the browser sends structured fields; the Relay builds MIME; CR/LF in any field is rejected; reply headers come from Gmail, not from the browser.
- **Per-app timers:** Gmail 30 min / 5 min idle; Spotify 45 min / 15 min idle; both capped by the token's own lifetime. Background polling (`GET /spotify/player`) does not extend idle. Enforced by the Relay.
- **Google grants stay separate:** `include_granted_scopes` and `access_type=offline` are forbidden (`worker/src/vendors.ts`).
- **No third-party JavaScript** in the page. Spotify plays on *your* device via Spotify Connect; the Web Playback SDK (needs a token in the browser + third-party script) is intentionally not used.
- Gmail content is shown as plain text (`textContent`), URLs are not clickable, the real sender address is always shown.
- Spotify images are only accepted from `https://i.scdn.co/` (the only extra `img-src` in the CSP).

## Residual risks (accepted, as in spec §2)
- A malicious computer can see anything displayed and can steal the capability while it is valid (up to 30/45 min). Use *Read only*, lock when done, and revoke connected apps if in doubt.
- Someone who talks you into reading them the 6-digit code can still trick you; typing raises the bar, it does not remove human error.
- Google/Spotify grants persist in your account ("connected apps") until you remove them: myaccount.google.com/permissions, spotify.com/account/apps.
- One Durable Object instance handles all traffic. Fine for personal use; not for many users.

## Cloudflare products on the Relay route
Plain `workers.dev` Worker + one Durable Object. No Bot Management, WAF challenge, Turnstile or Access, so no `__cf_bm`/`cf_clearance` cookies are set. Re-check if you add a custom domain or any of those.

## Manual checklist (run after each deploy)
- [ ] Devtools > Application: no cookies / localStorage / sessionStorage / IndexedDB for the site
- [ ] Network tab: no response contains `ya29.`, `access_token` or Spotify token strings
- [ ] Refresh: everything locked
- [ ] `curl -X POST <relay>/link/claim/<id>` without `X-Claim-Secret` is rejected
- [ ] Wrong code 3× locks the request; phone page shows no code
- [ ] Gmail *Read only*: no compose button; API write calls return 403
- [ ] Gmail *Read & write*: reply stays in thread; 11th send blocked; an address with a line break is rejected
- [ ] Untick the permission on Google's consent screen: you get the "not connected" page, no session
- [ ] Unlock both apps, lock one: the other keeps working; old capability returns 401 with curl
- [ ] Wait past the idle limit: capability rejected server-side
- [ ] Email containing `<script>` renders as inert text
- [ ] `npx wrangler tail` while using everything: no tokens, codes, capabilities or mail/track data in logs
- [ ] Page cannot be embedded in another site
- [ ] `git log -p | grep -i "client_secret"` finds nothing

## Assumptions not fixed by the spec
Gmail caps (10 sends, 10 recipients, 50 KB body) and Spotify limits (45 min / 15 min idle) are my defaults; Read only is the default access level; `GET /health` exposes booleans about configuration; Spotify token exchange sends a client secret and a PKCE verifier together (if Spotify rejects that, remove `code_verifier` for Spotify only in `vendors.ts`).


---

# v2.1 addendum: Spotify web player (in-tab)

**Exception E1 (owner-approved, this feature only):** a Spotify access token (about 1 hour) is delivered to the browser, because Spotify's Web Playback SDK needs it there. Everything else in this document still applies.

## Design
- The player is a **separate site on a separate origin** (a free GitHub organization Pages site). It loads Spotify's script; the workspace (which holds Gmail capabilities) never does. The workspace only opens the player in a new tab with `noopener,noreferrer`. **No token, capability or message passes between the two sites.**
- The player runs the same link flow (claim secret, typed code, 3 tries) for `spotify` with access level `stream`.
- **The Relay keeps nothing for a web-player unlock:** at claim the token is returned once to the holder of the claim secret and deleted; no session, no capability, no refresh token, no account information (the Relay never calls Spotify's profile endpoint). The token exists on the Relay only sealed (AES-GCM) and only during the 2.5 minute transaction.
- **Origin rules enforced by the Relay:** only `PLAYER_ORIGIN` may start or claim a `stream` transaction; the workspace origin may start everything else but can never claim a stream token; the player origin may only call `/link/*` (Gmail, Spotify remote control and session revoke are workspace-only). The Relay refuses the player entirely if `PLAYER_ORIGIN` equals `FRONTEND_ORIGIN` (`player_not_isolated`) or is unset (`player_not_configured`).
- Phone is redirected back to the site that showed the QR (the player).
- Spotify's script is loaded **after** unlock only, never on the QR or phone pages.

## Player controls
- CSP (meta): `script-src 'self' https://sdk.scdn.co`; `connect-src` only the Relay and Spotify hosts (a compromised script has nowhere else to send data); images only from Spotify's CDN. `style-src` allows inline styles because Spotify's script injects some.
- Token in memory; optional `sessionStorage` mirror (off by default; only if the user ticks "Keep me unlocked"); cleared on lock, expiry and when Spotify rejects it. Never localStorage, cookies or IndexedDB by this code.
- Auto-lock: token expiry, 30 minutes without click/key (client-side), or the DONE button. DRM (Widevine) is checked before Spotify's script is loaded.
- Frame-buster (GitHub Pages cannot send `frame-ancestors`).

## New residual risks (accepted)
- Spotify's script is third-party code running in the player tab. Isolation limits what it can reach (no Gmail, no workspace state) and the CSP limits exfiltration, but it can see the token and the tab. The SDK cannot be pinned with SRI.
- The token cannot be revoked before it expires (no Spotify revoke endpoint); DONE only forgets it locally.
- The token can read the account's email and country (SDK-required scopes).
- Client-side auto-lock is a UX guard: the Relay cannot enforce it because the token, once delivered, is valid at Spotify for its whole life.
- Reopening a closed tab may restore `sessionStorage` if "Keep me unlocked" was ticked.
- The Web Playback SDK may keep its own data in the player origin's storage; check devtools > Application after use.

## Manual checklist additions
- [ ] Workspace build output contains no `sdk.scdn.co` (grep `web/dist`)
- [ ] Workspace tab has no reference to the token (devtools > Network on the workspace while unlocking the player)
- [ ] `POST /link/start` with `access:"stream"` from the workspace origin returns 403; from the player origin with `app:"gmail"` returns 403
- [ ] `/link/claim` for a stream transaction from the workspace origin returns 409
- [ ] After DONE, player-origin sessionStorage is empty
- [ ] `wrangler tail` shows no token/refresh token
- [ ] `/health` shows `"player":true` only when PLAYER_ORIGIN differs from FRONTEND_ORIGIN
