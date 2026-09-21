# Sakkol Workspace: Roadmap and Security Rules for the AI Implementation Agent

**Audience:** an AI coding agent (chatbot) that will extend this repository, one version at a time.
**Owner:** the person who runs this workspace on untrusted shared computers (usually in an incognito window).
**Versions covered:** v2.1 (Spotify in-tab) → v3 (Google Keep) → v4 (Notion) → v5 (Google Drive) → v6 (Google Calendar).

---

## 0. How you must work

1. **Read this whole document and the code before writing anything.** Read `docs/SECURITY.md`, `docs/API.md`, `docs/SECURITY-REVIEW-v1.md`, `worker/src/core.ts`, `worker/src/index.ts`, `worker/src/apps.ts`, `worker/src/vendors.ts`, `worker/src/gmail.ts`, `web/src/core/*`.
2. **One version per session, in order.** Finish, test and document a version before starting the next. Do not "prepare" later versions inside an earlier one.
3. **Feasibility gates are real.** Some requested apps may not be possible without breaking the security model (see v3). When a gate fails, stop and tell the owner; do not work around it.
4. **Stop and ask** (do not guess) when: a rule in section 2 would have to be bent; a vendor's current docs contradict this document; a scope, permission or data flow is not described here; the owner must choose between security and convenience.
5. **Never ask the owner to paste secrets into the chat.** Give them commands to run themselves (`npx wrangler secret put NAME`).
6. **Do not invent API details.** This document was written from knowledge that may be out of date. Every "verify" note means: read the vendor's current official documentation first and record what you found in the version's PR description.
7. Follow the existing style: small files, no framework, plain TypeScript, `h()` DOM helper, tests for security logic.

### 0.1 Deliverables for every version
- Code in `worker/` and `web/`, with **automated tests** for every new security rule (section 2), following `worker/test/*.test.ts`.
- Updated `docs/API.md`, `docs/SECURITY.md` (new controls, new residual risks), and `SETUP-STEPS.md` (exact console steps for the owner: Google Cloud / Spotify / Notion / Cloudflare / GitHub).
- A short **manual security checklist** additions section.
- A final report in this format:
  ```
  ## Version X report
  What was built | Files changed | Tests added (and results)
  Security decisions NOT specified in the roadmap (each with reasoning)
  Spec conflicts found and how they were resolved (or "asked owner")
  Things I could not verify
  Steps the owner must do (console/secrets), in order
  ```

---

## 1. Current state (what already exists)

| Piece | Where | Notes |
|---|---|---|
| Static frontend (TypeScript, Vite, vanilla DOM) | `web/` | Hosted on GitHub Pages at `https://sakkol.github.io/workspace/`. Views: launcher (tiles), unlock (QR + code), phone confirm page, Gmail, Spotify remote |
| Relay | `worker/` (Cloudflare Worker + one Durable Object class **`Store`**) | `https://sakkol-relay.serdarakkol.workers.dev`. Never rename `Store` or change the `[[migrations]]` block |
| Pure logic (testable in Node) | `worker/src/core.ts` (`StoreCore`) | link transactions, sessions, rate limits, cleanup alarm. **No Cloudflare imports** |
| App and vendor registries | `worker/src/apps.ts`, `worker/src/vendors.ts` | one entry per app / OAuth vendor |
| Routes | `worker/src/index.ts`, `gmail.ts`, `spotify.ts`, `mime.ts` | |
| Tests | `worker/test/` (core, mime, security, router) and `web/test/` | Run: `cd worker && npm test`, `cd web && npm test` |
| Docs | `README.md`, `SETUP-STEPS.md`, `docs/*` | |

**Implemented already (do not redo):**
- Gmail read-only **or** read & write; **inbox tabs (Inbox/Primary, Promotions, Updates)** and **conversation view** (whole thread in one chain, older messages collapsed, quoted history folded).
- Spotify **remote control** (music plays on the owner's own device; no Spotify token in the browser).
- Security fixes from the v1 review: claim secret, typed verification code, scope/lifetime validation, vendor revocation, token encryption at rest, in-memory rate limits, frame-buster, lockfiles.

### 1.1 How linking works today (you will extend this)
1. Shared browser generates a random **claim secret**, sends only its SHA-256 (`claimHash`) with `POST /link/start {app, access}`.
2. Relay creates a 2.5 min transaction with a 6-digit **code**. The QR contains only the transaction id.
3. Phone opens the page, sees what is requested and where from, **types the code** (3 tries), then is sent to the vendor's own consent page (PKCE S256 + `state`).
4. Relay callback exchanges the code, checks granted scopes and token lifetime, stores the token **AES-GCM sealed** (`TOKEN_KEY`).
5. Shared browser polls `status` and calls `claim` **with the claim secret**; receives an opaque **capability** (one per app) held only in JavaScript memory.
6. Every API call sends `Authorization: Bearer <capability>`. The Relay checks: capability exists, is bound to **that app**, not expired (hard limit and idle limit), then uses the vendor token server-side.
7. DONE / timer / refresh ends the session; the Relay revokes the token at the vendor when the vendor has an endpoint.

---

## 2. Non-negotiable security rules

These carry over from spec v1.2 and the v1 review. **If a task seems to require breaking one, stop and ask (rule R25).** Exceptions approved by the owner are listed in section 3 and apply only where stated.

**Credentials in the browser**
- **R1.** The shared browser must never persist authentication: no cookies, `localStorage`, `IndexedDB`, Cache Storage, service workers for auth. Only the exception E1 (section 3) is allowed, and only where stated.
- **R2.** Provider (Google/Notion/Spotify...) **access tokens stay on the Relay**. The browser holds only opaque capabilities. Exception: E1.
- **R3.** Capabilities live only in a JavaScript variable, are sent only in the `Authorization` header, never in URLs, query strings, cookies or `postMessage` to another origin (E1 is the only cross-origin case).
- **R4.** **One capability per app.** The Relay must reject a capability on any route that belongs to another app (`store.auth(cap, app)`), and a rejected cross-app use must look identical to an expired session.

**OAuth**
- **R5.** Authorization Code flow with **PKCE S256** and a per-transaction single-use `state`, exact registered redirect URIs, on the phone only. The phone page never collects a vendor password.
- **R6.** Never request offline access or keep refresh tokens. If a vendor returns one (Spotify does; Notion may), **discard it** and set `expectsRefreshToken: true` for that vendor so it is not logged as an error. Never log token values.
- **R7.** **Never set `include_granted_scopes`.** Never merge scopes into a token except through the explicit bundle mechanism defined in v3, and then only for apps of the *same vendor* the owner chose in the same unlock.
- **R8.** Request the **minimum scopes**. Verify at callback that **every requested scope was granted** (users can untick scopes). Default access level is **read-only**; write access is an explicit per-unlock choice shown on the phone.
- **R9.** Session lifetime = `min(app maximum, token lifetime − 60 s)`. The Relay is authoritative; browser timers are UX only. Idle timeouts measure **human** activity only: background polling routes must be marked passive **on the server**, never by a client header.

**Linking**
- **R10.** Keep the claim secret (status/claim need it), the typed code (never returned by `/link/info`), the 3-try lock, the pending-transaction cap and the single-use rules. Do not weaken any of them for convenience.
- **R11.** The QR code and phone URL contain only the transaction id.

**Input, output and content**
- **R12.** Treat everything a vendor returns as **untrusted data**. Render only with `textContent`/the `h()` helper (text nodes), never `innerHTML`. Do not make URLs clickable (phishing on a shared computer). Do not render vendor HTML, SVG, iframes or embeds. Show real sender/owner identifiers, not just display names.
- **R13.** Never proxy an arbitrary path, URL or query from the browser to a vendor. Use **route allow-lists**, ID **regexes**, **enum whitelists** for labels/actions, and **length limits**. Build vendor requests on the Relay from structured fields (see `mime.ts` for the model: CR/LF anywhere in a header field is rejected).
- **R14.** Every write capability needs **server-side caps** (per-minute rate and a per-session counter kept in the Durable Object, as `sendSlot` does for Gmail). Prefer reversible operations (trash, not delete). Permanent deletion is out of scope unless the owner explicitly asks and a typed confirmation exists.
- **R15.** Every new route needs a rate limit (`c.lim(bucket, n)`), a body-size limit (existing `json()` helper) and a test for the 401/403 cases.

**Platform**
- **R16.** No new identity provider, no user accounts, no database, no Firebase/Auth0/Clerk/Supabase/Cloudflare Access.
- **R17.** No third-party JavaScript in the main frontend origin. The only allowed script source is `'self'`. Any new CSP entry must be justified in `docs/SECURITY.md`. (v2.1 defines the single sanctioned exception: an isolated origin.)
- **R18.** Secrets only in Cloudflare secrets (`wrangler secret put`). Never in the repo, `wrangler.toml` `[vars]`, `VITE_*` variables or logs. Client IDs are public and may be in `[vars]`.
- **R19.** Logs must never contain tokens, codes, capabilities, PKCE verifiers, or vendor content (mail, notes, files, events, tracks). Log only event types and reason categories.
- **R20.** **Fail closed**: missing secret/config means an explicit "not configured" error, never a fallback to weaker behaviour (see `configured()` and the `TOKEN_KEY` check).
- **R21.** Minimise dependencies. New runtime dependencies need a written justification; commit lockfiles; use `npm ci`. Prefer the platform (`fetch`, WebCrypto).
- **R22.** **Forbidden approaches:** unofficial/undocumented APIs; libraries that need the owner's Google password, app passwords or "master tokens" (this rules out unofficial Google Keep libraries); scraping; browser extensions; any flow that asks for a vendor password on the shared computer.
- **R23.** Tokens at rest are AES-GCM sealed with the record key as AAD (`hooks.seal/open`). New stored token fields must go through the same path.
- **R24.** Keep `worker/src/core.ts` free of Cloudflare imports so its logic stays unit-testable.
- **R25.** **Spec conflict procedure:** write a note titled `SPEC CONFLICT` (what you need, which rule it touches, options with trade-offs), stop, and ask the owner. Do not silently change the security model.

### 2.1 Test requirements
Every new rule you implement gets a test. Minimum for a new app: unlock happy path through the router with a mocked vendor; wrong-app capability rejected both ways; scope shortfall rejected; read-only session cannot call write routes; input validation cases (bad IDs, injection strings, oversize bodies); write caps; expiry (hard and idle); revocation calls the vendor once; token never appears in any response body or redirect.

---

## 3. Exceptions and decisions already made by the owner

| # | Decision | Applies to |
|---|---|---|
| **E1** | For the **Spotify in-tab player only** (v2.1): the Spotify access token (≤ 1 h) may live in the browser **of the isolated player origin**, in JavaScript memory and optionally mirrored to `sessionStorage` (never `localStorage`, cookies or IndexedDB) with an expiry timestamp so a page refresh in the same tab does not stop playback. The owner uses this in an incognito tab. The Spotify **capability** may be mirrored the same way. Both are deleted on Lock, on expiry and when the token is rejected. | v2.1 only |
| E2 | The owner wants **Google Keep to unlock together with Gmail** (no second QR scan). Implemented through the bundle mechanism in v3. **Gate:** only if Keep is technically possible (see v3). | v3 |
| E3 | Order of work: v2.1, v3, v4, v5, v6. | all |
| E4 | Default access level is read-only; write is an explicit choice on the launcher tile. | all |

Everything else stays as in spec v1.2 plus `docs/SECURITY.md`.

---

## 4. Pattern: adding an app (use for every version)

1. `worker/src/apps.ts`: add the app id to `AppId`, and an `AppDef` (vendor, scopes per access level, phone description text, `maxLifeMs`, `idleMs`).
2. `worker/src/vendors.ts`: add a vendor only if it is a new OAuth provider (auth URL, token URL, client-auth style, extra params, `expectsRefreshToken`, `revoke`).
3. `worker/src/env.ts`, `wrangler.toml`: new client id var (public) and secret name; add to `configured()`/`creds()` so an unconfigured vendor returns `app_not_configured`.
4. `worker/src/<app>.ts`: route handler with allow-lists, validation, rate limits, passive-route rules, error mapping; register in `index.ts` under a **prefix owned by that app** (`/notion/`, `/drive/`, ...).
5. Frontend: tile in `web/src/apps/registry.ts`, folder `web/src/apps/<app>/`, a `registerWiper(...)` that clears in-memory data on lock, UI text errors in `core/api.ts`.
6. Tests, docs, `SETUP-STEPS.md` console steps, manual checklist.

---

## 5. Version specifications

### v2.1: Spotify inside the tab (Web Playback SDK)

> **STATUS: IMPLEMENTED.** Deviations from the design below (owner's choices): the player is hosted on a **GitHub organization Pages site** (not Cloudflare Pages); the token is **delivered once at claim** to the player origin (`claimToken`, access level `stream`), so there is **no capability, no Relay session and no `/spotify/sdk-token` route**; the QR/code are shown **in the player site**, which the workspace opens in a new tab (no iframe, no cross-site messages); `sessionStorage` mirroring is **opt-in** (default off). See `docs/SECURITY.md` (v2.1 addendum) and `SETUP-STEPS-v2.1.md`. Treat the text below as design history.

**Goal:** the shared computer's own tab becomes a Spotify player (audio from that browser), so the owner does not need Spotify open on another device. Keep the existing remote-control mode.

**Why this needs care:** the SDK is JavaScript loaded from `sdk.scdn.co` and needs an access token in the page. Anything in the same JavaScript context or same **origin** as that script can be read by it. The main origin holds the Gmail (and future) capabilities, so **the SDK must never run in the main origin.**

**Design (required properties; implementation details are yours):**
1. **Separate origin for the player**, for example a Cloudflare Pages project (`sakkol-player.pages.dev`). **A second GitHub Pages site under the same account is NOT isolated**: all `*.github.io/…` paths of one account share an origin. Alternative to evaluate: a `sandbox="allow-scripts"` iframe *without* `allow-same-origin` (opaque origin). Prototype both; the SDK may not work inside a sandboxed opaque origin (storage/EME). Report what you found before choosing.
2. The player origin is its **own tiny app** (separate Vite entry/build, no Gmail code): it runs the same unlock flow (QR, claim secret, typed code) for app `spotify` with a new access level **`stream`**, holds only Spotify credentials (E1), and the phone page for that flow is served by the player origin too.
3. The main app embeds the player origin in an `<iframe allow="autoplay; encrypted-media">` (or opens it in a new tab). **No capability or token is ever sent between origins.** No `postMessage` carrying credentials in either direction; messages may only carry non-sensitive UI state (e.g. "locked").
4. Relay:
   - New access level `stream` for `spotify` with scopes `streaming user-read-email user-read-private user-read-playback-state user-modify-playback-state` (the SDK requires the first three; note that they expose the owner's email and country to the token holder, so `stream` must be an explicit choice and shown on the phone).
   - New route `POST /spotify/sdk-token` (only for sessions with access `stream`): returns `{token, expiresInMs}`. This is the **only** place a provider token ever leaves the Relay. Rate-limit it (e.g. 20/min), never log the response, `Cache-Control: no-store`.
   - **Origin ↔ app rules (R-multiorigin):** introduce `PLAYER_ORIGIN`. `FRONTEND_ORIGIN` may use every app **except** `spotify` with `access: "stream"`; `PLAYER_ORIGIN` may use **only** `spotify`. Enforce in the router with tests (wrong origin gets 403). CORS answers with the specific matching origin, never `*`. The phone endpoints (`/link/info|confirm|cancel`) accept both origins because the phone opens the origin that displayed the QR.
   - Session limits for `stream`: `maxLifeMs` 45 min (token lasts about 60 min), idle handled as for the remote mode.
5. Player origin hardening: its own CSP (build it minimally by testing; expected: `script-src 'self' https://sdk.scdn.co`, `frame-src https://sdk.scdn.co`, `connect-src` the Relay plus Spotify's API/WebSocket hosts, `img-src https://i.scdn.co`, `media-src` as the SDK requires; write down every host you had to add and why), `frame-ancestors` = main origin only (Cloudflare Pages `_headers`), `Referrer-Policy: no-referrer`, the same frame-buster logic where framing is not intended. The SDK script cannot be pinned with SRI; this residual risk is accepted **only because** the origin is isolated and holds only Spotify credentials.
6. Lock/expiry: `player.disconnect()`, delete token + capability from memory and `sessionStorage` (E1), call `POST /session/revoke`. If the SDK reports an authentication error, drop everything.
7. Browser realities to test and report: Premium account required for the SDK; autoplay policy needs a user click (`activateElement()`); DRM (EME/Widevine) availability in the owner's incognito browser (Firefox private windows may disable DRM; check); Spotify Development Mode limits (owner Premium, ≤ 5 users) still apply.

**Acceptance criteria**
- [ ] Main origin contains no reference to `sdk.scdn.co` (grep the build output).
- [ ] A Gmail capability cannot reach `/spotify/sdk-token`; a `stream` capability cannot reach `/gmail/*`.
- [ ] Requests from the wrong origin for an app are rejected (tests).
- [ ] Token appears only in the `/spotify/sdk-token` response, nowhere in logs, URLs, redirects or other responses.
- [ ] After Lock, `sessionStorage` of the player origin holds no token or capability.
- [ ] Playback works in the owner's incognito window (or a documented limitation is reported).
- [ ] Remote-control mode still works unchanged.

**Owner steps to document:** create the Cloudflare Pages project, set `PLAYER_ORIGIN`, add the player's redirect is **not** needed (OAuth returns to the Relay), add `PLAYER_ORIGIN` to the Relay `[vars]`, redeploy.

---

### v3: Google Keep, unlocked together with Gmail

#### Feasibility gate (do this first, before writing code)
As of the last check for this document, Google's **Keep API is available only to Google Workspace (enterprise/education) customers**; it is not offered to personal `@gmail.com` accounts, and the documented authorization paths are domain-wide delegation with a service account or an OAuth client approved by a Workspace administrator (scopes `https://www.googleapis.com/auth/keep` and `.../keep.readonly`). **Verify against https://developers.google.com/workspace/keep/api/guides.**

Ask the owner: *"Is the Google account you unlock with a Workspace account whose administrator can enable the Keep API and approve the scope for your OAuth client?"*

- **No (personal account):** **do not build Keep.** Do **not** use unofficial Keep libraries (they rely on passwords/master tokens: forbidden by R22). Report this and propose alternatives that work with personal accounts and the same Google vendor: **Google Tasks** (`https://www.googleapis.com/auth/tasks`, checklists/notes-like tasks) or notes stored via Drive (v5). Implement the *bundle mechanism* below with the alternative app, if the owner agrees.
- **Yes (Workspace):** proceed. Note that domain-wide delegation with a service account is **not** allowed here (it would put a key that can impersonate users on the Relay, breaking the single-user OAuth model). Use user OAuth with an admin-approved client only. If that is impossible, stop and ask.

#### Bundle mechanism (required for E2; also reusable for v5 and v6)
Goal: one QR scan, one typed code, one Google consent screen, several Google apps unlocked.
- A transaction may carry `apps: AppId[]` **all belonging to the same vendor**, each with its own access level. Scopes sent to Google = union of those apps' scopes. **Nothing else may be bundled** (never mix vendors).
- Launcher: when unlocking Gmail, show a checkbox "Also unlock Keep" (default per owner's E2: on) with its own read/write choice. The phone confirmation screen must list **every app and access level** being granted.
- Callback: verify **all** union scopes were granted (R8). If not, fail the whole transaction (or, if you want partial success, only unlock apps whose scopes were all granted and tell the phone user precisely; choose the simpler safe option and document it).
- Claim returns multiple capabilities: `{caps: {gmail:{cap,ttlMs,access}, keep:{...}}}`. **One session record per app** (own capability, own timers, own limits, own write counters). Each capability is still bound to exactly one app (R4).
- All sessions of a bundle share one Google token. Sealed copies are stored per session; add a **token-group id**. **Revoke the token at Google only when the last live session of the group ends**, otherwise locking Gmail would silently kill Keep (and vice versa). Test both orders plus expiry.
- Update `core.ts` tests: bundle happy path, partial scope grant, group revocation, one app expiring while the other continues, wrong-app capability.
- Document in `docs/SECURITY.md` that same-vendor bundles mean one Google token carries several scopes; the Relay's per-capability route binding is the isolation boundary (a Relay bug could cross-use scopes). This is a deliberate trade for convenience.

#### Keep functionality (Workspace only)
- Verify the current Keep API surface. Expected: list/get notes, create notes, delete notes, and media download; no in-place editing of existing notes. Do not promise features the API lacks.
- Default read-only: list and view notes (title, text, list items with checked state). Write mode: create text/list notes. **Delete is permanent in Keep**: either omit it or require typed confirmation, a per-session cap, and clearly warn (R14).
- Note contents are untrusted (R12). Attachments/media: not in v3.
- Routes under `/keep/*`, IDs validated by regex, `passive` none.

**Acceptance criteria:** feasibility gate answered and recorded; single unlock yields two independent capabilities; locking one leaves the other working and the Google token alive; last lock revokes the token exactly once; all R-tests pass.

---

### v4: Notion

**Goal:** search and read pages; optionally create a page or append text.

**Verify first (Notion docs, https://developers.notion.com):** current OAuth endpoints, whether the token endpoint requires HTTP Basic auth with a JSON body (historically yes), whether **PKCE** is supported, whether access tokens now **expire** and come with **rotating refresh tokens** (reports in 2026 suggest yes), whether there is a **token revocation** endpoint, current `Notion-Version` header, and rate limits (about 3 requests/second average). Record findings.

**Design notes**
- Register a **public integration** at notion.so/my-integrations. Notion has **no OAuth scopes**: the owner picks which pages/databases to share on the consent screen, and the integration's *capabilities* (read content, update content, insert content, user info) are configured on the integration itself.
- Because capabilities live on the integration, a Relay-enforced "read-only" unlock is weaker than provider-enforced read-only. **Recommended:** create **two integrations**, "Sakkol Read" (read content only) and "Sakkol Write", each with its own client id/secret (`NOTION_READ_*`, `NOTION_WRITE_*`); the `read` access level uses the read-only integration so Notion itself enforces it. If the owner declines, the Relay must still refuse all write routes for `read` sessions and this weaker guarantee must be documented.
- `vendors.ts` needs: an app definition with **no scope parameter** (extend `AppDef` with an explicit `noScopes` flag and skip scope verification for it; keep the rule that verification is mandatory whenever scopes exist), `owner=user` on the authorize URL, JSON token exchange (add a `tokenBody: "json" | "form"` option to `exchange()`), and Basic client auth.
- Refresh tokens: discard (R6). Session lifetime uses the returned `expires_in` if present; if the token does not expire, use the app maximum (30 min) and note that Notion offers no relay-side way to kill the token except a revoke endpoint if one exists (use it if it does; else document that the owner must remove the integration from Notion).
- Routes (allow-list): `POST /notion/search` `{query}`, `GET /notion/pages/:id` (page properties + block children rendered to **plain text** with pagination), write mode: `POST /notion/pages` (create a page with a title and plain paragraphs under a parent the owner picked from search results) and `POST /notion/blocks/:id/append` (plain paragraphs). IDs are UUIDs (validate strictly). Cap block count and text size. No file/image/embed rendering (Notion file URLs are pre-signed and expiring; do not surface them). No deleting/archiving.
- Rich text is untrusted; convert to text (R12); mentions and links show as text only.
- Write caps: e.g. 20 writes per session.

**Acceptance criteria:** all R-tests; token/refresh token never in responses or logs; read-only session cannot reach any write route (both by Relay and, if two integrations, by Notion); UUID validation tests; rendering of a hostile page (script tags, huge blocks, deep nesting) stays inert and bounded.

---

### v5: Google Drive

**Goal:** browse, search and preview files. Google vendor (can join the v3 bundle mechanism if the owner wants one scan for Gmail + Drive; ask).

**Scopes (choose the least that works; explain):**
- `https://www.googleapis.com/auth/drive.metadata.readonly`: names, folders, types (good default for browsing).
- `https://www.googleapis.com/auth/drive.readonly`: content preview. This is a **restricted** scope: fine in Testing mode (≤ 100 test users), needs the owner to add it under Data Access in Google Cloud.
- `drive.file` only sees files the app created/opened; not useful for browsing, so do not use it for v5.
- Write scopes (`drive`) are **out of scope for v5**.

**Functionality:** folder browsing, search (structured fields only: file name contains, type filter; the Relay builds the Drive `q` string and escapes quotes/backslashes; the browser never sends raw `q`), file details, **text preview**: Google Docs via export as `text/plain`, Sheets via export CSV limited to the first N rows/KB, plain text/markdown/CSV files truncated to a size limit. PDFs, images, Office files, binaries: show metadata only (no rendering).

**Security decisions to enforce (and ask the owner where marked):**
- **No downloads onto the shared computer** (persists on disk; spec §12 excluded attachment downloads). *Ask the owner* if they want an explicit "download" later; if yes it needs a per-file confirmation and a size cap.
- File IDs validated by regex; never accept a URL; never return `webViewLink`/`webContentLink` as clickable links (show as text if at all).
- File names and contents are untrusted (R12). Cap sizes; bound pagination.
- Shared drives / "shared with me": include only if the owner asks; note privacy implications.
- Idle 5 min, max 30 min as Gmail.

**Acceptance criteria:** Relay-built `q` injection tests (quotes, backslashes, `' or trashed=true or '`), oversize file preview truncation, export MIME allow-list, read-only enforcement (there are no write routes), token revoke on lock, cross-app capability tests.

---

### v6: Google Calendar

**Goal:** agenda (today/week), event details; optional create/edit/delete events in write mode. Google vendor (bundle-capable).

**Scopes (verify current names and sensitivity):** `https://www.googleapis.com/auth/calendar.events.readonly` or `calendar.readonly` for read; `https://www.googleapis.com/auth/calendar.events` for write. Listing the owner's calendars may need a separate read scope; request only what the UI uses.

**Security-relevant design:**
- **Inviting attendees sends emails to other people as the owner** (the same risk class as sending mail). In v6 write mode: no attendees field, or if the owner wants it, cap attendees (e.g. 5), and always send with `sendUpdates=none` unless the owner explicitly opts in for a given event with a confirmation step. Per-session write counter (e.g. 20).
- Deleting events is destructive: require a confirmation step and count against the write cap; prefer "cancel" semantics only if the API offers them; document.
- Do not create or show conferencing links as clickable; show text only (R12).
- Timezones: store and display with explicit IANA zone; tests for DST boundaries and all-day events.
- Event titles, descriptions and locations are untrusted text.
- Read-only default (E4).

**Acceptance criteria:** read-only session cannot call write routes; attendee and `sendUpdates` handling tested; write caps tested; DST/all-day rendering tests; token revoke on lock.

---

## 6. Cross-cutting work to schedule with the versions

| When | Task |
|---|---|
| v2.1 | Multi-origin CORS (`FRONTEND_ORIGIN` + `PLAYER_ORIGIN`) with per-app origin rules; second frontend entry/build and deploy workflow |
| v3 | Bundle mechanism (`apps[]`, multi-capability claim, token groups, group-aware revoke) |
| v4 | `noScopes` apps, JSON token exchange, optional per-access-level client credentials |
| v5, v6 | Reuse the bundle mechanism; add app-specific caps |
| every version | Launcher tile state (locked/unlocked/coming soon), phone screen text listing exact access, wipers on lock, `docs/*`, `SETUP-STEPS.md` |
| after v6 | Optional: per-send phone approval for Gmail; unlock-several-at-once UX polish |

---

## 7. Practical facts and gotchas learned so far

- **Durable Object:** class must stay `Store`; do not edit `[[migrations]]`. `StoreCore` is instantiated per DO instance; in-memory rate-limit counters reset on eviction (acceptable).
- **Config checks:** `GET /health` returns configuration booleans only; extend it for new vendors (booleans, never values).
- **Cloudflare:** stay on `workers.dev` without Bot Management/WAF challenge/Turnstile so no `__cf_bm` or `cf_clearance` cookies are set. Document any change.
- **CSP** is a `<meta>` tag in `web/index.html` (GitHub Pages cannot send headers); `frame-ancestors` is not supported in meta CSP, hence the JS frame-buster. Cloudflare Pages `_headers` (`web/public/_headers`) gives real headers.
- **`crypto.subtle` is unavailable on plain-http LAN staging**; `web/src/core/crypto.ts` has a tested SHA-256 fallback. Do not remove it.
- **GitHub Pages** project sites share one origin per account (`sakkol.github.io`): never treat two project sites as isolated.
- **Vite:** `base: "./"`; the build needs the repository variable `VITE_RELAY_URL` (public, no trailing slash) or the CSP breaks.
- **Google OAuth:** app is in *Testing* mode with the owner as test user; restricted scopes (`gmail.modify`, `drive.readonly`) are allowed there; consent shows an "unverified app" warning; each new scope requires adding it under Data Access.
- **Gmail inbox tabs** rely on Gmail's `CATEGORY_*` labels. If the owner disables tabs in Gmail, the Primary tab will be empty; do not silently fall back to another query.
- **Spotify Development Mode:** owner needs Premium; max 5 authorized users; search limited to 10; some endpoints were removed in the February 2026 migration. Always check the live docs.
- **Staging:** a second Worker (`--env staging`) plus Vite on a LAN IP lets the phone leg be tested without touching production (see `SETUP-STEPS.md`).

---

## 8. Definition of done (every version)

The version is done only when: all R-rules still hold; tests for every new rule pass (`worker` and `web`); the production build succeeds; `docs/API.md`, `docs/SECURITY.md`, `SETUP-STEPS.md` and the manual checklist are updated; a Wrangler dry run bundles (`npx wrangler deploy --dry-run`); the final report (section 0.1) lists every unverified assumption; and the owner has been told exactly which console steps and secrets are needed, in order, with commands they run themselves.
