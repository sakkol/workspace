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


---

# v3 addendum: Outlook (Microsoft Graph)

Microsoft is a **new vendor** (`microsoft`), unlocked with its own QR scan. It is never bundled with Gmail or Spotify (R7) and has its own capability, bound to app `outlook` (R4).

## Controls
- **Plain OAuth, no MSAL.** MSAL adds `offline_access` (refresh token) and `openid profile email` (identity). The authorize URL has PKCE S256, `state`, the exact redirect URI, `prompt=select_account` and the exact scopes; a test asserts it never contains `offline_access`, `include_granted_scopes` or `client_secret`. Client secret goes in the token request body, server-side only.
- **Scopes:** read = `Mail.Read`; write = `Mail.ReadWrite Mail.Send`. Never requested: `offline_access`, `MailboxSettings.*` (rules, auto-forward), `Mail.*.Shared`, `User.*`, `Directory.*`, `Contacts.*`, `Calendars.*`. `Mail.ReadWrite` can move/flag/edit mail; the Relay exposes only read, flag, move to Archive/Deleted Items/Inbox and send/reply, and never calls `DELETE`. `Mail.ReadWrite` would also permit editing message drafts and content at Graph level; that power exists on the Relay-held token only, and the Relay's route allow-list is the boundary.
- **Scope check with a vendor normalizer** (`normalizeScope`): lower-case, `https://graph.microsoft.com/` prefix stripped; **every requested scope must be present**; extra default scopes Microsoft adds (`User.Read`, `profile`, `openid`, `email`) are tolerated and never used.
- **No refresh token, no account info (R6, R26):** if Microsoft returns a refresh token it is discarded and only `security_event: unexpected_refresh_token (discarded)` is logged. The Relay never calls `/me`; unread/total counts come from `/me/mailFolders/inbox`. Tenant defaults to `consumers`; an invalid `MICROSOFT_TENANT` makes the vendor "not configured" (fail closed).
- **Sessions:** 30 min max, 5 min idle, capped at `expires_in − 60 s`, enforced by the Relay. Microsoft has **no access-token revocation endpoint**: on Lock/expiry the Relay deletes its (AES-GCM sealed) copy; the token itself stays valid at Microsoft until it expires (60–90 min). It never left the Relay.
- **Injection / SSRF:** conversation and message ids match `^[A-Za-z0-9_=-]{1,300}$` (so no quotes or OData operators); `odataStr()` additionally doubles single quotes. Folders are a whitelist. The browser never supplies a URL: for paging the Relay reads only `$skiptoken`/`$skip` out of Graph's `@odata.nextLink` (only if it points at `graph.microsoft.com`) and hands the browser an opaque token that is regex-validated on the way back; the request is rebuilt by the Relay.
- **Content is untrusted text (R12):** bodies are requested as text; HTML that arrives anyway is reduced to text (`htmlToText`, shared with Gmail). Rendered with `textContent` in a `<pre>`; links are not clickable; the real sender address is always shown.
- **Write limits:** read-only sessions get 403 on every write route (tested: no Graph call is made). Trash = move to Deleted Items. 10 sends/session (send and reply share the counter, kept in the Durable Object), 3 sends/min, 60 writes/min, ≤ 30 messages touched per conversation action. **Reply recipients are chosen by Outlook**, not by the browser; reply-all, Bcc, attachments, forwarding, categories, rules and permanent delete do not exist.
- `Prefer: IdType="ImmutableId"` is sent on every Graph call so message ids survive moves (otherwise archive/trash would change the id).

## Residual risks (accepted)
- The Microsoft access token cannot be revoked early (see above). A "connected app" entry stays in the Microsoft account until removed at https://account.live.com/consent/Manage.
- The app-registration **client secret expires** (max 24 months). When it does, Outlook unlocks fail with "failed" on the phone until a new secret is stored (`npx wrangler secret put MICROSOFT_CLIENT_SECRET`).
- Conversation `count` in a list is per page/folder and may be lower than the true conversation size; the conversation view shows the real count.
- Graph's own idea of a "conversation" (`conversationId`) may differ from what Outlook's UI shows (e.g. subject changes).

## Manual checklist additions (v3)
- [ ] `/health` shows `"microsoft":true` only after client id, secret, redirect and tenant are set
- [ ] Phone consent screen lists exactly `Mail.Read` (read) or `Mail.ReadWrite` + `Mail.Send` (write) and **not** "Maintain access to data you have given it access to" (that is `offline_access`)
- [ ] After unlock, `wrangler tail` shows no token, address or mail content
- [ ] Read-only Outlook session shows no Compose/Reply/Flag/Archive/Delete buttons
- [ ] Delete moves the conversation to Deleted Items (it can be found there in Outlook); nothing is permanently deleted
- [ ] Reply goes to the address shown as "Outlook sends this reply to"
- [ ] Outlook DONE, then the old capability returns 401 (`session_expired`)
- [ ] Outlook capability cannot open Gmail/Spotify routes and vice versa (covered by automated tests; spot check in the Network tab)


---

# v3.1 addendum: Google Tasks and the Google bundle

## The bundle (one sign-in for Gmail + Tasks)
- **Google only.** `makeBundle()` refuses any app whose vendor is not `google`, duplicates, `stream`, unknown apps and more than 3 apps. Outlook and Spotify always unlock on their own (R7). The launcher checkbox is **off by default**, and the partner app has its own access level (read-only by default).
- **Scopes:** exactly the union of the chosen apps' scopes (for example `gmail.readonly` + `tasks`). Never `include_granted_scopes`, never offline access. The phone lists **every app and its access level** before approval.
- **All or nothing:** the callback requires every scope of every app. If any is missing (for example Tasks unticked), the whole unlock fails, the token is revoked at Google and nothing is claimable.
- **One session per app.** Claim returns one capability per app; each is bound to exactly one app (a Tasks capability on a Gmail route is `401`, and the reverse). Timers, idle limits and write counters are per session. Each session holds its own AES-GCM sealed copy of the token (own AAD) and a shared random *group id*.
- **Shared token, group-aware revocation:** locking or expiring one app does **not** revoke the Google token while another session of the group is alive. The token is revoked when the last live session ends (Lock, idle, hard expiry, cleanup alarm), exactly once (tests cover both orders, one app expiring while the other continues, and simultaneous expiry).
- **What the bundle changes:** while both apps are unlocked, one Google access token carries both scopes on the Relay. **Per-capability route binding on the Relay is the isolation boundary.** The token itself never reaches the browser. If a Google call is rejected (401), only the session that made it is removed.

## Google Tasks
- Scopes: read = `tasks.readonly`; write = `tasks`. The `tasks` scope would technically allow deleting tasks and lists; the Relay exposes neither (R14: reversible operations only), no `DELETE` method is representable in its Google client, and a test asserts none is ever sent.
- Everything is Relay-built from whitelisted fields (title, notes, due, status). IDs and paging tokens are regex-checked; the browser never supplies a URL or query.
- Titles and notes are untrusted text (plain text nodes, links not clickable).
- Limits: 60 writes/min and **200 changes per session**, counted in the Durable Object after validation.
- Completed tasks are only fetched on request (`showHidden=true` is required by Google to see tasks completed in its own apps).

## Manual checklist additions (v3.1)
- [ ] Unlock Gmail alone: the consent screen lists only Gmail. Unlock Tasks alone: only Tasks.
- [ ] Unlock with "Also unlock Google Tasks": the phone lists both apps with their access levels; Google's screen lists both permissions
- [ ] Untick one permission on Google's screen: the unlock fails ("did not grant") and nothing appears on the computer
- [ ] Lock Gmail: Tasks keeps working. Lock Tasks afterwards: both gone. Then check https://myaccount.google.com/permissions still lists the app (Google keeps the entry) but the old token is dead
- [ ] Read-only Tasks session shows no Add/Edit/checkbox controls
- [ ] Completing a task in Sakkol shows it as completed in the Google Tasks app


---

# v4 addendum: Notion

## Findings about Notion's OAuth (verified in Notion's docs, Sept 2026)
- Authorize: `https://api.notion.com/v1/oauth/authorize?owner=user&client_id&redirect_uri&response_type=code&state`. **No scope parameter**: access is whatever pages the owner selects on Notion's approval screen, limited by the integration's *capabilities* configured in Notion.
- Token: `POST https://api.notion.com/v1/oauth/token`, HTTP Basic (`client_id:client_secret`), **JSON** body, `Notion-Version` header. The response has `access_token` and a `refresh_token` (plus `bot_id`, workspace info and the **owner's name and e-mail**); it has **no `expires_in`**.
- Revocation exists: `POST /v1/oauth/revoke` (Basic auth, JSON `{token}`). Latest API version is `2026-03-11`.
- Rate limits: ~3 requests/s on personal plans. Text items are limited to 2000 characters, arrays to 100 elements.

## SPEC CONFLICT resolved by the owner: no PKCE (R5)
Notion's token API has no `code_verifier`, so PKCE S256 is impossible for this vendor. The owner accepted the exception (option A). `pkce: false` in the vendor definition means the Relay sends neither `code_challenge` nor `code_verifier`. Remaining protections: single-use `state` bound to the transaction, exact registered redirect URI, the typed code plus claim secret, and the client secret that never leaves the Relay (an intercepted authorization code cannot be exchanged by anyone else). The exception applies to Notion only; a test asserts Google, Microsoft and Spotify still send PKCE.

## Controls
- **Two integrations so Notion enforces read-only.** `read` unlocks use integration *Sakkol Notion Read* (capability: read content only) and `write` unlocks use *Sakkol Notion Write* (read + insert content; no update, no comments, no user information). Credentials are chosen by access level; a missing level is "not configured" and never falls back to the other one. The Relay additionally refuses every write route for `read` sessions (tested: nothing reaches Notion).
- **No scopes**: `noScopes` apps skip scope verification *only* because the vendor has none (R8 stays mandatory for every app that has scopes; tested).
- **Nothing kept from the token response** except the access token: the refresh token, bot id, workspace info and the owner's name and e-mail are dropped in `exchange()` (R6, R26), not stored, returned or logged.
- **Session:** 30 min max, 5 min idle. Notion gives no expiry, so the app maximum applies; if Notion rejects the token earlier the session is removed. On Lock/expiry the Relay **revokes the token at Notion** with the matching integration's credentials (best effort).
- **Bounded, inert rendering (R12):** only `plain_text` of rich text is used (no links, mention targets or annotations); text lands in DOM text nodes; file/image/embed/bookmark URLs (pre-signed, expiring) are never surfaced, only `[image]` and the caption; block text ≤ 4000 chars, 100 blocks per request, nested blocks load only on request and only 3 levels deep in the UI; unknown block types become a placeholder; types and ids are pattern-checked before being returned.
- **Strict inputs (R13):** UUID-only ids and cursors (lower-case, dashed), title/text length limits, Relay-built request bodies (parent `page_id`, plain paragraphs). `archived`/`in_trash` is never written; the Notion client cannot send `DELETE`, and `PATCH` only exists for appending children (a test fails if any other PATCH or a DELETE is ever sent).
- **Write caps (R14):** 10 writes/min and **20 per session**, counted in the Durable Object after validation. New content is additive only (create page, append at the end). There is no edit and no delete in this workspace; remove mistakes in Notion.

## Residual risks
- The Notion token cannot be shortened by us; Lock revokes it, but if that best-effort call fails it lives until Notion expires it. It never leaves the Relay.
- Revoking may disconnect the integration from the workspace at Notion's side (not documented either way), in which case the next unlock asks for page selection again. Safe, slightly less convenient.
- "Read only" relies on the owner configuring the **read** integration with *only* "Read content". If it is given more capabilities in Notion, the Relay still blocks writes for `read` sessions, but Notion would not.
- A write session can add content to every page that was shared with the write integration. Share only what you need on Notion's approval screen.

## Manual checklist additions (v4)
- [ ] `/health` shows `"notion":true,"notionWrite":true`
- [ ] Notion's approval screen for **Read** says it can *read content* only; for **Write** it adds *insert content* and nothing about comments/user information
- [ ] Only the pages you selected appear in the workspace search; an unselected page returns "not found"
- [ ] Read-only session shows no "Add text / New page" buttons; with the Write integration's capabilities reduced to read-only in Notion, writes fail on Notion's side too
- [ ] "Add text" appends at the end of the page; nothing existing is changed. "New page here" creates a child page
- [ ] After DONE, the old capability is 401; `wrangler tail` shows no token, e-mail or page content
