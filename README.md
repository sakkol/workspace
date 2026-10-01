# Sakkol Workspace (v4.1)

A small personal workspace for **untrusted shared computers**. You unlock each app with your **trusted phone**; the shared browser never sees a password and never stores a login.

| App | Access levels |
|---|---|
| Gmail | read-only, or read & write (send, reply, star, archive, trash) |
| **Notion** | read-only (search pages, browse databases and rows), or read & write (create pages, append text, add and edit database rows; no delete) |
| Google Tasks | read-only, or read & write (add, edit, complete; no delete) |
| Outlook / Hotmail | read-only, or read & write (send, reply, flag, archive, delete = move to Deleted Items) |
| Spotify | remote control of your own devices, or a web player in a separate tab |
| Widgets | clock, countdown timer, quick links (all in memory) |

**One sign-in for several Google apps:** tick "Also unlock Google Tasks" on the Gmail tile (or the reverse). One QR scan, one Google consent screen, one capability per app.

Google Drive and Calendar are planned (see `docs/NEXT-STEPS-FOR-AI-AGENT.md`).

## How unlocking works

1. On the shared computer, tap **Unlock** on a tile. It shows a QR code and a 6-digit code.
2. Scan the QR with your phone, **type the code**, then approve on Google's / Microsoft's / Spotify's own page.
3. A small relay (Cloudflare Worker) receives the vendor token and keeps it encrypted. The browser gets only an opaque, short-lived **capability** held in JavaScript memory.
4. **DONE**, a timer, or a page refresh ends the session.

```
Shared browser  ──capability──▶  Relay (Cloudflare Worker + Durable Object)  ──token──▶  Gmail / Microsoft Graph / Spotify
     ▲                                          ▲
     └── QR + typed code ── your phone ── OAuth consent (PKCE)
```

## What v4.1 adds: Notion databases

- **Databases tab:** search databases, open a table's rows (title search, paging), open a row as a page; databases inside a page open from the page.
- **Add and edit rows** with a typed form (text, number, select, multi-select, status, date, checkbox, URL, e-mail, phone) and a review step. Other column types are read-only.
- The Relay reads the real column schema from Notion for every write and builds the values itself; it never creates new select options and never changes a database's structure. The only page update it can send is `{properties}`.
- Editing needs **"Update content"** on the Write connection (see `docs/SECURITY.md` v4.1 for the trade-off). Write allowance is now 50 per session.

## What v4 added: Notion

- Search page titles, read pages as plain text (nested blocks on demand), and in write mode create a page under a page or append text at the end of a page. No editing or deleting.
- **Two Notion connections** ("Read" with *read content* only, "Write" with read + insert) so **Notion itself** enforces read-only. The Relay also refuses writes for read sessions.
- Notion has no scopes and no PKCE: the owner chooses the shared pages on Notion's own screen; the exception to PKCE is documented in `docs/SECURITY.md`.
- Nothing is kept from Notion's token response except the access token (refresh token, workspace and owner info are dropped). Lock revokes the token at Notion.
- Write limits: 10/min and 50 per session (since v4.1). Images, files and link targets are never shown.

## What v3.1 added: Google Tasks and the Google bundle

- **Google Tasks:** lists, open/completed tasks, add, edit (title, notes, due date), complete/reopen. Google's `tasks` scope could also delete; the Relay has **no delete route** and never sends `DELETE`.
- **Bundle (Google apps only):** one QR scan unlocks Gmail + Tasks, each with its own access level (e.g. Gmail read-only, Tasks read & write). Off by default. The phone lists every app being granted. If any permission is unticked on Google's screen, the whole unlock fails.
- Each app still has its **own capability**; using one on the other's routes is refused. The shared Google token is revoked only when the **last** app of the bundle is locked or expires.
- Tasks write limits: 60 changes/min and 200 per session.

## What v3 added: Outlook

- Personal Microsoft accounts (tenant `consumers`) via **Microsoft Graph**, plain OAuth (no MSAL).
- Same interface as Gmail. The mail UI now lives in `web/src/apps/mail/` and Gmail and Outlook plug into it through a small adapter.
- Plain Inbox plus Sent, Archive, Deleted Items and Junk; conversation view with folded quoted text.
- Scopes: `Mail.Read` (read) or `Mail.ReadWrite` + `Mail.Send` (write). **Never** `offline_access`, so Microsoft issues no refresh token.
- Replies are addressed by Outlook itself; the browser can only supply the text.
- Never calls Graph `DELETE`, and never calls `/me` (no name or address is requested).

## Security highlights

- No cookies, `localStorage`, `IndexedDB` or service workers hold credentials in the shared browser.
- Vendor tokens stay on the relay, AES-GCM encrypted; no refresh tokens are kept.
- One capability per app; using it on another app's routes looks the same as an expired session.
- Sessions: 30 min max and 5 min idle for mail, both capped by the token's own lifetime and enforced by the relay.
- Write actions are capped: 10 sends per session, 3 per minute, no Bcc, attachments, forwarding or permanent delete.
- Mail is rendered as plain text only; links are not clickable; the real sender address is always shown.
- Every route uses allow-lists, strict ID patterns and length limits. Paging never follows a URL supplied by the browser.

Details, residual risks and the manual checklist: [`docs/SECURITY.md`](docs/SECURITY.md).

**Bundle note:** while Gmail and Tasks are unlocked together, one Google token carrying both scopes sits on the Relay (never in the browser). Per-capability route binding is the isolation boundary.

## Known limits

- Microsoft has no revocation endpoint for access tokens. After DONE the relay forgets the token at once, but it stays valid at Microsoft until it expires (60–90 min). It never reaches the shared computer.
- The Outlook app registration's **client secret expires** (max 24 months). Set a reminder and renew it.
- Outlook has no search, and the message count in a list is per page (the conversation view shows the real count).
- Not yet tested against a live Microsoft account beyond the automated tests: see the checklist in `docs/SECURITY.md`.

## Repository layout

| Path | Contents |
|---|---|
| `web/` | Static frontend (TypeScript, Vite, vanilla DOM), hosted on GitHub Pages |
| `worker/` | Relay: Cloudflare Worker + one Durable Object (`Store`) |
| `worker/src/core.ts` | Pure, unit-tested logic (link transactions, sessions, rate limits) |
| `worker/src/outlook.ts` | Outlook routes (Graph) |
| `worker/src/tasks.ts` | Google Tasks routes |
| `worker/src/notion.ts` | Notion routes |
| `web/src/apps/mail/` | Shared mail UI (list, conversation view, compose) |
| `docs/` | `API.md`, `SECURITY.md`, roadmap and review notes |

## Develop

```bash
cd worker && npm ci && npm test && npx tsc --noEmit
cd ../web  && npm ci && npm test && npx tsc --noEmit && npx vite build
```

The frontend build needs the repository variable `VITE_RELAY_URL` (public, no trailing slash).

## Set up

Follow [`docs/SETUP-STEPS.md`](docs/SETUP-STEPS.md). Outlook is **Phase 6** (an Entra app registration, one secret, three Graph permissions). Google Tasks is **Phase 7** (enable one API, add two scopes; no new secret). Notion is **Phase 8** (two Notion connections, two secrets). Spotify web player: [`docs/SETUP-STEPS-v2.1.md`](docs/SETUP-STEPS-v2.1.md).

When updating from a zip, delete everything except `.git` first so files removed in a new version don't linger.
