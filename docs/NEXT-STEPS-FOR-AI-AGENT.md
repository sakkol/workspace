# Sakkol Workspace: Roadmap and Security Rules for the AI Implementation Agent

**Audience:** an AI coding agent (chatbot) that will extend this repository, one version at a time.
**Owner:** the person who runs this workspace on untrusted shared computers (usually in an incognito window).
**Versions covered:** v2.1 (Spotify web player, **BUILT**) → v3 (**Outlook email, BUILT**; see docs/SECURITY.md v3 addendum) → v4 (Notion) → v5 (Google Drive) → v6 (Google Calendar). Google Keep was dropped from the roadmap (its API is Workspace-only).

---

## 0. How you must work

1. **Read this whole document and the code before writing anything.** Read `docs/SECURITY.md`, `docs/API.md`, `docs/SECURITY-REVIEW-v1.md`, `worker/src/core.ts`, `worker/src/index.ts`, `worker/src/apps.ts`, `worker/src/vendors.ts`, `worker/src/gmail.ts`, `web/src/core/*`.
2. **One version per session, in order.** Finish, test and document a version before starting the next. Do not "prepare" later versions inside an earlier one.
3. **Feasibility gates are real.** Some requested apps may not be possible without breaking the security model (see the "verify / ask the owner first" notes in each version). When a gate fails, stop and tell the owner; do not work around it.
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
| Docs | `README.md`, `SETUP-STEPS.md`, `SETUP-STEPS-v2.1.md`, `docs/*` | |
| **Spotify web player (separate repo)** | `sakkol-player` (own repo in a **GitHub organization**, own origin, e.g. `https://sakkol-player.github.io/player/`) | v2.1. Own Vite build, own CSP, own deploy workflow. `src/core/dom.ts`, `src/core/crypto.ts`, `test/crypto.test.ts` are **copies** of the workspace files: keep them in sync |
| Workspace page widgets | `web/src/widgets/*`, `web/src/config.ts` | Clock, timer, quick links. **`config.ts` is the only file the owner edits** to change links and extra clocks |

**Implemented already (do not redo):**
- Gmail read-only **or** read & write; **inbox tabs (Inbox/Primary, Promotions, Updates)** and **conversation view** (whole thread in one chain, older messages collapsed, quoted history folded).
- Spotify **remote control** (music plays on the owner's own device; no Spotify token in the browser).
- **Spotify web player in a browser tab (v2.1)**, see the v2.1 section.
- **Workspace page widgets:** clock (12/24 h, optional extra time zones), countdown timer (presets + custom, keeps running across screens, header chip, alarm sound scheduled on the audio clock so it works in background tabs, tab-title countdown), and owner-configured quick links (https only, `noopener noreferrer`). All in memory, nothing stored. Quick links are static owner config and are the only clickable links in the app; vendor content stays non-clickable (R12).
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
- **R7.** **Never set `include_granted_scopes`.** Never merge scopes into a token except through the optional Google bundle mechanism described under v5, and then only for apps of the *same vendor* the owner chose in the same unlock.
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
- **R22.** **Forbidden approaches:** unofficial/undocumented APIs; libraries that need the owner's Google password, app passwords or "master tokens" (this rules out unofficial Google Keep libraries and IMAP/SMTP logins with passwords or app passwords for Outlook); scraping; browser extensions; any flow that asks for a vendor password on the shared computer.
- **R23.** Tokens at rest are AES-GCM sealed with the record key as AAD (`hooks.seal/open`). New stored token fields must go through the same path.
- **R24.** Keep `worker/src/core.ts` free of Cloudflare imports so its logic stays unit-testable.
- **R26.** **Owner preference: the Relay keeps no refresh token and no account information.** Do not store, log or return the user's email address, name, id or country, and do not call identity endpoints (`/me`, `userinfo`, Spotify profile) unless a feature strictly needs them. Anything a vendor hands over that is not needed is discarded.
- **R25.** **Spec conflict procedure:** write a note titled `SPEC CONFLICT` (what you need, which rule it touches, options with trade-offs), stop, and ask the owner. Do not silently change the security model.

### 2.1 Test requirements
Every new rule you implement gets a test. Minimum for a new app: unlock happy path through the router with a mocked vendor; wrong-app capability rejected both ways; scope shortfall rejected; read-only session cannot call write routes; input validation cases (bad IDs, injection strings, oversize bodies); write caps; expiry (hard and idle); revocation calls the vendor once; token never appears in any response body or redirect.

---

## 3. Exceptions and decisions already made by the owner

| # | Decision | Applies to |
|---|---|---|
| **E1** | **In use (v2.1 is built).** For the **Spotify in-tab player only**: the Spotify access token (≤ 1 h) may live in the browser **of the isolated player origin**, in JavaScript memory and optionally mirrored to `sessionStorage` (never `localStorage`, cookies or IndexedDB) with an expiry timestamp so a page refresh in the same tab does not stop playback. The owner uses this in an incognito tab. The Spotify **capability** may be mirrored the same way. Both are deleted on Lock, on expiry and when the token is rejected. | v2.1 only |
| E2 | **Outlook email replaces Google Keep as v3.** It is a different vendor (Microsoft), so it is its own unlock with its own QR scan and is **never bundled** with Gmail (R7). | v3 |
| E3 | Order of work: v2.1 (done), v3 Outlook, v4 Notion, v5 Drive, v6 Calendar. | all |
| E4 | Default access level is read-only; write is an explicit choice on the launcher tile. | all |
| E5 | No Cloudflare Pages. Extra sites are hosted on GitHub Pages under a separate free GitHub organization (a separate origin). | hosting |
| E6 | Owner uses the workspace in incognito/InPrivate windows on shared computers. | all |

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

### v2.1: Spotify web player in a browser tab: BUILT

**Do not redo this. Do not weaken it.** Read `docs/SECURITY.md` (v2.1 addendum) and `SETUP-STEPS-v2.1.md`.

What exists:
- Workspace launcher: the Spotify tile offers **Web player (opens a new tab)** and **Remote control**. The web-player option does `window.open(VITE_PLAYER_URL, "_blank", "noopener,noreferrer")`. No token, capability or `postMessage` passes between the two sites.
- **Player site** (`sakkol-player`, separate repo, GitHub organization Pages, its own origin): shows the QR + code, phone flow, claims the token once, loads Spotify's SDK **only after unlock** (never on QR/phone pages), checks Widevine DRM first, runs the player, search and play through Spotify's Web API directly with the token. Locks on DONE, on token expiry, after 30 minutes without click/key, or when Spotify rejects the token. Optional `sessionStorage` mirror, **off by default** (owner ticks "Keep me unlocked").
- **Relay:** access level `stream` for `spotify` (scopes `streaming user-read-email user-read-private user-read-playback-state user-modify-playback-state`). `claimToken()` hands the token over **once** to the holder of the claim secret and stores nothing: no session, no capability, no refresh token, no account info (R26). `PLAYER_ORIGIN` / `PLAYER_URL` config. **Origin rules:** only `PLAYER_ORIGIN` may start/claim `stream`; the workspace origin may start everything else and can never claim a stream token; the player origin may call only `/link/*`. If `PLAYER_ORIGIN` equals `FRONTEND_ORIGIN` or is unset the player is refused (`player_not_isolated` / `player_not_configured`). The phone is redirected back to the site that showed the QR. `/health` reports `player`.
- Player CSP: scripts only from itself and `sdk.scdn.co`; `connect-src` only the Relay and Spotify hosts (limits exfiltration by the third-party script); images only Spotify CDN. `style-src 'unsafe-inline'` is allowed for Spotify's injected styles.

Known limits (accepted by the owner): no early revocation (Spotify has no revoke endpoint); the token expires in about an hour and the Relay keeps no refresh token, so the owner scans again hourly; the token can read the account's email/country (SDK-required scopes); Premium required; Spotify Development Mode limits (owner Premium, at most 5 users, search 10 results); Firefox private windows disable DRM; the CSP was written without a live browser test, so the first real run may need a host added (the console shows "Refused to ...").

Guard-rails for future work touching this: keep the tests in `worker/test/core.test.ts` ("stream (web player) transactions") and `worker/test/router.test.ts` ("spotify web player (isolated origin)"); keep the three origin rules; never load third-party scripts in the workspace origin; never let the workspace claim a stream token.

---

### v3: Outlook email (Microsoft Graph): BUILT

**Status:** built for a personal Microsoft account (tenant `consumers`); plain Inbox (owner declined Focused/Other); read and read & write. Guard-rails: `worker/test/outlook.test.ts`; no MSAL, never `offline_access`, never Graph `DELETE`, never `/me`. Conversation-level routes (`/outlook/conversations/:id/(action|trash|untrash)`) were added next to the specified message-level routes so the shared conversation UI works. The original spec follows unchanged.

**Goal:** the same experience as Gmail for the owner's Outlook mailbox: read, conversation view, and (optional, explicit) send/reply/organize. Microsoft is a **new vendor** (`microsoft`), a separate unlock/QR scan, **not bundled with anything** (R7).

#### Ask the owner and verify first (before coding)
1. **Which account type?** A personal Microsoft account (outlook.com, hotmail.com, live.com) or a Microsoft 365 work/school account? This decides the tenant setting (`consumers`, `organizations` or `common`) and whether consent is possible: work tenants can require **admin consent**, block apps from **unverified publishers**, or enforce **conditional access**. If work/school: ask whether an admin can approve; if not, stop and report.
2. **Read Microsoft Learn** and record what you found: v2.0 authorize/token endpoints; PKCE support for a web app that also has a client secret; delegated Mail permissions; access-token lifetime (documented as roughly **60 to 90 minutes**; always use the returned `expires_in`); the behaviour of `offline_access` (refresh tokens); well-known folder names; the `Prefer: outlook.body-content-type="text"` header; `sendMail` (returns 202, no body); throttling (429 + `Retry-After`).
3. Confirm how the owner registers an app if they only have a personal account (the Microsoft Entra admin center may create a default directory on first sign-in).

#### Design
- **Vendor `microsoft`** in `vendors.ts`: authorize `https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize`, token `.../oauth2/v2.0/token`; `MICROSOFT_TENANT` var; client secret **in the request body**; PKCE S256; `state`; `prompt=select_account`. **Write the plain OAuth requests yourself: do NOT use MSAL** (MSAL adds `offline_access`, `openid`, `profile`, `email` by default, which would produce a refresh token, breaking R6/R26). **The authorize URL must not contain `offline_access`** (add a test). `expectsRefreshToken: false`.
- Config: `MICROSOFT_CLIENT_ID` (public `[vars]`), `MICROSOFT_REDIRECT_URI` (`https://sakkol-relay.serdarakkol.workers.dev/oauth/microsoft/callback`), `MICROSOFT_TENANT`, secret `MICROSOFT_CLIENT_SECRET`. Extend `Env`, `creds()`, `configured()`, `/health` (booleans), `/oauth/(google|spotify|microsoft)` routes and the callback.
- **Scope verification needs a vendor-specific normalizer.** Microsoft's token response may list extra default scopes (`User.Read`, `profile`, `openid`, `email`), use different casing, or include the `https://graph.microsoft.com/` prefix. Today `approve()` compares exact strings: add `normalizeScope()` per vendor (lower-case, strip the prefix) and keep the rule that **every requested scope must be present**. Extra granted scopes must be tolerated and **never used**.
- **Access levels and scopes:** `read` → `Mail.Read`; `write` → `Mail.ReadWrite Mail.Send`. **Never request:** `offline_access`, `MailboxSettings.ReadWrite` (inbox rules / auto-forward), `Mail.*.Shared`, `User.ReadWrite*`, `Directory.*`, `Contacts.*`, `Calendars.*` (that is v6, separate). Owner sees the exact list on the phone screen.
- **Sessions:** 30 min max / 5 min idle, capped at `expires_in − 60 s`. Microsoft offers no revocation endpoint for access tokens: on Lock/expiry the Relay deletes its copy (the token never left the Relay); document that it stays valid at Microsoft until it expires. R26: do not call `/me` for identity; unread/total counts come from `GET /me/mailFolders/inbox?$select=unreadItemCount,totalItemCount`.
- **Routes `/outlook/*` (allow-list only, capability bound to app `outlook`):**
  - `GET /outlook/profile`: inbox counts + access level.
  - `GET /outlook/conversations?folder=&tab=&pageToken=`: Graph has **no thread list endpoint**. Fetch messages newest first (`$top` about 50, minimal `$select`: `id, conversationId, subject, from, receivedDateTime, isRead, bodyPreview, flag, inferenceClassification`) and **group by `conversationId` on the Relay**. `folder` ∈ well-known whitelist (`inbox`, `sentitems`, `archive`, `deleteditems`, `junkemail`). Optional tabs **Focused / Other** via `inferenceClassification` (Outlook's counterpart of Gmail tabs); fall back to plain Inbox where Focused Inbox is off. **Paging:** never accept or follow a client-supplied `@odata.nextLink`: extract only the `$skiptoken`/`$skip` value, validate by regex, and rebuild the request yourself (SSRF guard).
  - `GET /outlook/conversations/:conversationId`: `GET /me/messages?$filter=conversationId eq '<id>'` (check Graph's `$orderby` restrictions; sort by date on the Relay). **OData injection guard:** `conversationId` must match a strict regex (URL-safe base64 characters) **and** single quotes must be escaped by doubling; reject anything else.
  - **Bodies:** send `Prefer: outlook.body-content-type="text"`. If HTML still arrives, reduce it to text (reuse the `bodyText` HTML-stripper approach); **never return HTML** (R12). Cap body size.
  - **Write (write sessions only):** `POST /outlook/messages/:id/action` `{read|unread|flag|unflag|archive}` (PATCH `isRead`/`flag`; archive = `POST /me/messages/{id}/move` with `destinationId:"archive"`); `POST /outlook/messages/:id/trash` = **move to `deleteditems`**; `untrash` = move to `inbox`. **Never call Graph `DELETE`** (add a test that no DELETE request is ever made). `POST /outlook/send`: build the Graph JSON on the Relay (`contentType:"Text"`, recipients `{emailAddress:{address}}`, `saveToSentItems:true`), reuse `addrs()` validation (CR/LF rejected) and the same limits as Gmail (≤ 10 recipients, 150-char subject, 50 000-char body, **10 sends per session** via the Durable Object counter, 3/min). **Replies** use `POST /me/messages/{id}/reply` with `{comment}`: Outlook chooses the recipients and quotes the original, so the browser cannot choose a reply's recipients. No Bcc, attachments, forwarding, categories, rules or permanent delete.
  - **ID validation:** Graph ids are long URL-safe strings; strict regex (`^[A-Za-z0-9_=-]{1,300}$`) and `encodeURIComponent` in paths.
  - **Errors:** 401 → `session_expired` (and revoke the session), 403 → `outlook_forbidden`, 404, 429 (pass `Retry-After`), 5xx → `outlook_unavailable`.
- **UI:** same look and behaviour as the Gmail app (tabs Focused/Other, folders, **conversation view** with collapsed older messages and folded quoted history via `quote.ts`, review-and-send, read-only default). Prefer extracting the shared mail UI into `web/src/apps/mail/` behind a small adapter (`list / open / act / send`) rather than copying about 300 lines; keep the Gmail behaviour and tests unchanged. Add an Outlook tile (read / read & write, default read).
- **Owner console steps to write into `SETUP-STEPS.md`:** Microsoft Entra admin center → App registrations → New registration → supported account types per the owner's answer → Redirect URI, platform **Web**, the Relay callback above → Certificates & secrets → new client secret (**it expires; tell the owner the date and to set a reminder**) → API permissions → Microsoft Graph → Delegated → `Mail.Read`, `Mail.ReadWrite`, `Mail.Send` (personal accounts consent themselves; work accounts may need admin consent) → `npx wrangler secret put MICROSOFT_CLIENT_SECRET`, add the three public vars, redeploy, check `/health`.

**Acceptance criteria**
- [ ] Authorize URL has PKCE S256, `state`, exact redirect URI, and **no** `offline_access`, `include_granted_scopes` or `client_secret`.
- [ ] A refresh token in the token response (if any) is discarded, never stored or returned, and logged only as an event.
- [ ] Scope normalizer tests (casing, URL prefix, extra default scopes tolerated, missing scope rejected).
- [ ] OData-injection and SSRF/next-link tests; strict ID regex tests.
- [ ] Read-only session cannot send, move, flag or trash; trash uses `move`, never `DELETE`.
- [ ] Reply recipients come from Outlook, not the browser; send limits enforced; CR/LF rejected.
- [ ] Outlook capability gets 401 on `/gmail/*`, `/spotify/*` and the reverse; Gmail and Spotify behaviour unchanged.
- [ ] No token, address or name in any response body, redirect or log (R26, R19).
- [ ] `docs/API.md`, `docs/SECURITY.md`, `SETUP-STEPS.md`, manual checklist updated; unverified points listed in the report.

---

### v4: Notion

**Goal:** search and read pages, create a page and append text.

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

**Goal:** browse, search and preview files. Google vendor. Optionally joins the **Google bundle mechanism** (below) if the owner wants one QR scan for Gmail + Drive; ask.

#### Optional: Google bundle mechanism (one scan for several Google apps; reused by v6)
**Status: BUILT in v3.1** (Gmail + Google Tasks; see docs/SECURITY.md v3.1 addendum). Drive and Calendar only need an `AppDef`, a route file and a tile: `makeBundle()` already accepts any Google app, up to 3 per bundle.
Only for apps of the **same vendor** (Google). Never bundle across vendors (Outlook, Spotify and Notion always unlock separately).
- A transaction may carry `apps: AppId[]`, each with its own access level. Scopes sent to Google = the union of those apps' scopes. Launcher: checkboxes "Also unlock Drive / Calendar" (default off unless the owner says otherwise). The phone screen lists **every app and access level** being granted.
- Callback: verify **all** union scopes were granted (R8); if not, fail the whole transaction (simplest safe option; document it).
- Claim returns several capabilities: `{caps: {gmail:{cap,ttlMs,access}, drive:{...}}}`. **One session record per app** (own capability, timers, limits, write counters). Each capability stays bound to exactly one app (R4).
- The sessions of a bundle share one Google token. Store sealed copies per session plus a **token-group id**, and **revoke the token at Google only when the last live session of the group ends**; otherwise locking Gmail would silently kill Drive. Test both orders and expiry.
- Tests: happy path, partial scope grant, group revocation, one app expiring while another continues, wrong-app capability.
- `docs/SECURITY.md`: a bundle means one Google token carries several scopes; per-capability route binding is the isolation boundary.

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

**Goal:** agenda (today/week), event details; optional create/edit/delete events in write mode. Google vendor (bundle-capable, see v5).

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
| v2.1 (done) | Multi-origin CORS (`FRONTEND_ORIGIN` + `PLAYER_ORIGIN`) with per-app origin rules; separate player repo and deploy workflow |
| v3 | New vendor `microsoft` (plain OAuth, no MSAL, scope normalizer, no `offline_access`); Outlook routes; shared mail UI extraction |
| v4 | `noScopes` apps, JSON token exchange, optional per-access-level client credentials |
| v5, v6 | Optional Google bundle mechanism (`apps[]`, multi-capability claim, token groups, group-aware revoke); add app-specific caps |
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
- **Two front-end origins now exist** (workspace and player). Never merge them; never point `PLAYER_ORIGIN` at `sakkol.github.io`. A repo under the same GitHub account shares the workspace origin.
- **GitHub Pages must publish the Vite build, not the repo files.** Source must be "GitHub Actions" and `.github/workflows/deploy.yml` must exist. A default Jekyll workflow publishes unbuilt `src/main.ts` (blank page, console shows `video/mp2t` and a literal `%VITE_RELAY_URL%`). Hidden `.github` folders are easy to lose when copying files by hand.
- **Copied files:** `dom.ts`, `crypto.ts`, `crypto.test.ts` exist in both the workspace and the player repo. Change both.
- **Timer/clock widgets** keep their state only in memory (R1). Browsers throttle timers in background tabs, so the timer computes from timestamps and the alarm sound is scheduled on the audio clock.
- **Staging:** a second Worker (`--env staging`) plus Vite on a LAN IP lets the phone leg be tested without touching production (see `SETUP-STEPS.md`).

---

## 8. Definition of done (every version)

The version is done only when: all R-rules still hold; tests for every new rule pass (`worker` and `web`); the production build succeeds; `docs/API.md`, `docs/SECURITY.md`, `SETUP-STEPS.md` and the manual checklist are updated; a Wrangler dry run bundles (`npx wrangler deploy --dry-run`); the final report (section 0.1) lists every unverified assumption; and the owner has been told exactly which console steps and secrets are needed, in order, with commands they run themselves.
