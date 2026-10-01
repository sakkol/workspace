# Relay API

All responses are JSON with `Cache-Control: no-store`. Except `/health` and `/oauth/*`, requests must come from `FRONTEND_ORIGIN` (CORS). `Origin` is a browser guard, **not** authentication: the real protections are the claim secret and the capability.

Errors look like `{ "error": "code" }`.

## Linking (per app)

| Method & path | Caller | Notes |
|---|---|---|
| `POST /link/start` `{app, access, claimHash, also?}` | shared computer | `app` ∈ `gmail`,`tasks`,`outlook`,`notion`,`spotify`; **`also`** (optional, Google apps only) = `[{app, access}]`, e.g. `[{"app":"tasks","access":"read"}]`: one Google sign-in unlocks several apps, each with its own access level. Max 3 apps, no duplicates, `stream` not allowed, Outlook/Spotify never; otherwise 400 `bad_request`; `access` ∈ `read`,`write` (Spotify: `write` = remote control) or `stream` (Spotify web player: only from `PLAYER_ORIGIN`; everything else only from `FRONTEND_ORIGIN`, else 403 `wrong_origin`; 503 `player_not_configured` / `player_not_isolated`); `claimHash` = base64url SHA-256 of a 32-byte secret only the browser knows. Returns `{id, code, ttlMs}`. 503 `app_not_configured` if the vendor secrets are not set. |
| `GET /link/status/:id` header `X-Claim-Secret` | shared computer | `{status}`: `pending` `approved` `expired` `consumed` `cancelled`. Wrong/missing secret looks like `expired`. |
| `POST /link/claim/:id` header `X-Claim-Secret` | shared computer | One time. From the workspace: `{caps:{<app>:{cap,ttlMs,access}}, cap, ttlMs, app, access}` (`caps` has one entry per app; the top-level fields are the primary app). From the player origin (stream only): `{token, ttlMs, app, access}`: the Spotify token is returned once and the Relay keeps nothing. 409 otherwise. |
| `GET /link/info/:id` | phone | `{app, access, vendor, label, describe, ctx{ua,city,country}, ageSec, ttlMs}`. **Never includes the code.** |
| `POST /link/confirm/:id` `{code}` | phone | Code typed by the user. 403 `wrong_code` (`left` attempts), 410 `locked` after 3 wrong tries. Returns `{nonce}`. |
| `POST /link/cancel/:id` (optional `X-Claim-Secret`) | either | |

## OAuth (browser navigations)

| Path | Notes |
|---|---|
| `GET /oauth/google`, `GET /oauth/spotify` `?tx=&n=` | Starts consent. PKCE S256 + per-transaction `state`. No `access_type`, no `include_granted_scopes`. |
| `GET /oauth/google/callback`, `GET /oauth/spotify/callback` | Exchanges the code, verifies the granted scopes and lifetime, redirects the phone to `FRONTEND_URL#/p/<id>/done` or `/error?r=`. |

## Session

`POST /session/revoke` (Bearer capability): destroys the session and revokes the token at Google (Spotify and Microsoft have no revoke endpoint for access tokens: the Relay just deletes its copy).

## Gmail (Bearer capability of app `gmail`)

| Path | Access | Notes |
|---|---|---|
| `GET /gmail/profile` | read | `{unread,total,access,ttlMs}` |
| `GET /gmail/threads?label=&q=&pageToken=` | read | One row per **conversation**. `label` ∈ INBOX (Primary) PROMOTIONS UPDATES STARRED SENT TRASH ALL; 25 per page. Tabs use Gmail's `CATEGORY_*` labels, so Gmail's inbox tabs must be enabled. Returns `{threads:[{id,subject,senders[],count,date,snippet,unread,starred}], nextPageToken}` |
| `GET /gmail/threads/:id` | read | Whole conversation, oldest first (last 30 messages): `{id,subject,count,truncated,messages:[{id,from,fromAddr,replyTo,to,toAddrs,cc,date,unread,starred,sent,text}]}`. Plain text only |
| `GET /gmail/messages/:id` | read | One message, plain text only |
| `POST /gmail/(messages\|threads)/:id/action` `{action}` | write | `read` `unread` `star` `unstar` `archive`. On a thread it applies to every message in it |
| `POST /gmail/(messages\|threads)/:id/trash` / `untrash` | write | No permanent delete exists |
| `POST /gmail/send` `{to[],cc[],subject,body,replyToId?}` | write | Max 10 recipients, 150-char subject, 50 000-char body, **10 sends per session**. MIME is built by the Relay. No Bcc, attachments, forwarding. |

## Notion (Bearer capability of app `notion`) — v4

Ids are lower-case dashed UUIDs (`^[0-9a-f]{8}-…-[0-9a-f]{12}$`), cursors are UUIDs. The `read` access level uses a different Notion integration than `write` (Notion itself blocks writes for `read`). Notion sends `Notion-Version: 2026-03-11`. Text only: images, files, embeds and bookmarks appear as a placeholder, never as a URL; links in text are not returned. **No route edits, deletes, archives or moves anything; `/users` is never called.**

| Path | Access | Notes |
|---|---|---|
| `POST /notion/search` `{query?, cursor?}` | read | Title search over pages shared with the integration, newest edit first, 20 per page. Returns `{results:[{id,title,edited}], next}`. Empty query = recently edited pages. Trashed pages and non-pages are dropped |
| `GET /notion/pages/:id?cursor=` | read | `{id, title, props:[{name,value}], blocks:[{id,type,text,hasChildren,checked?,language?}], next}`. `title`/`props` only on the first page of results (no `cursor`). 100 blocks per page; `props` = up to 25 simple property types as text |
| `GET /notion/blocks/:id/children?cursor=` | read | Same block shape, for expanding toggles, lists, tables, columns |
| `POST /notion/pages` `{parentId, title, text?}` | write | Creates a page **under a page** (`parentId`). Title 1–300 chars, one line. `text` ≤ 20 000 chars: blank line = new paragraph, paragraphs cut at 1900 chars, ≤ 100 blocks. Returns `{id,title}` (no URL) |
| `POST /notion/blocks/:id/append` `{text}` | write | Appends plain paragraphs at the **end** of a page/block. Same text limits. Returns `{ok,added}` |

Limits: 120 requests/min, 10 writes/min, **20 writes per session** (`write_limit`, counted after validation). Errors: `session_expired`, `notion_forbidden` (page not shared, or the integration lacks the capability), `not_found` (Notion gives the same answer for unshared pages), `notion_rate_limited` (+`Retry-After`), `notion_unavailable`, `notion_bad_request`, `bad_id`, `bad_cursor`, `bad_query`, `bad_title`, `bad_text`, `too_many_blocks`, `read_only`.

## Google Tasks (Bearer capability of app `tasks`) — v3.1

Ids match `^[A-Za-z0-9_-]{1,200}$`; `@default` and paths are refused. Field limits: title 1–500 chars (one line), notes ≤ 8000, due = `YYYY-MM-DD` (Tasks stores the date only). **There is no delete route** and the Relay never calls `DELETE`.

| Path | Access | Notes |
|---|---|---|
| `GET /tasks/lists` | read | `{lists:[{id,title}]}` (up to 100) |
| `GET /tasks/lists/:lid/tasks?completed=1&pageToken=` | read | 100 per page. Default = open tasks; `completed=1` also returns completed ones (sent to Google with `showHidden=true`, needed for tasks completed in Google's own apps). `{tasks:[{id,title,notes,status,due,parent,updated}], nextPageToken}`. Links and every other Google field are dropped |
| `POST /tasks/lists/:lid/tasks` `{title, notes?, due?}` | write | Creates a task. Any other field (parent, id, status…) is ignored or refused |
| `POST /tasks/lists/:lid/tasks/:tid/update` `{title?, notes?, due?, status?}` | write | `status` ∈ `needsAction`,`completed`. `due: null` clears the date. At least one field |

Limits: 60 writes/min, **200 changes per session** (`write_limit`, counted only after validation). Errors: `session_expired`, `tasks_forbidden` (also when the Tasks API is not enabled), `tasks_rate_limited`, `tasks_unavailable`, `tasks_bad_request`, `bad_id`, `bad_page`, `bad_title`, `bad_notes`, `bad_due`, `bad_status`, `nothing_to_change`, `read_only`.

## Outlook (Bearer capability of app `outlook`) — v3

Microsoft Graph. Folder names are a whitelist of Graph well-known names: `inbox` `sentitems` `archive` `deleteditems` `junkemail`. Ids match `^[A-Za-z0-9_=-]{1,300}$`. Plain Inbox only (no Focused/Other). No search route. The Relay never calls `/me` (no name, address or id is requested).

| Path | Access | Notes |
|---|---|---|
| `GET /outlook/profile` | read | `{unread,total,access,ttlMs}` from `/me/mailFolders/inbox` |
| `GET /outlook/conversations?folder=&pageToken=` | read | Graph has no thread list: the Relay fetches 50 messages newest first and **groups by `conversationId`**. `count` = messages of that conversation on this page/folder. `pageToken` is our own opaque token (`t.<skiptoken>` or `s.<skip>`), never a URL. Returns `{threads:[{id,subject,senders[],count,date,snippet,unread,starred}], nextPageToken}` (`starred` = flagged) |
| `GET /outlook/conversations/:id` | read | Whole conversation, oldest first (last 30): same message shape as Gmail plus `replyHint` (who Outlook will reply to). Bodies are plain text (HTML is reduced to text) |
| `POST /outlook/conversations/:id/action` `{action, folder?}` | write | `read` (unread messages only) `unread` / `flag` (newest message) `unflag` (flagged ones) `archive` (messages currently in the inbox). ≤ 30 messages per call |
| `POST /outlook/conversations/:id/trash` `{folder?}` / `untrash` | write | **Move** to `deleteditems` (from `folder`, default `inbox`) / back to `inbox`. Graph `DELETE` is never called |
| `POST /outlook/messages/:id/action` `{action}` / `trash` / `untrash` | write | Same operations on one message |
| `POST /outlook/send` `{to[],cc[],subject,body}` | write | Max 10 recipients, 150-char subject, 50 000-char body, **10 sends per session** (shared with replies), 3/min. Graph JSON built by the Relay (`Text`, `saveToSentItems:true`). No Bcc, attachments, forwarding |
| `POST /outlook/messages/:id/reply` `{comment}` | write | Outlook chooses the recipients and quotes the original. Any other field in the body is ignored. Counts as a send |

Errors: `session_expired` (401, also when Graph rejects the token: the session is removed), `outlook_forbidden` (403), `not_found`, `outlook_rate_limited` (429 + `Retry-After`), `outlook_unavailable` (502), `outlook_bad_request` (400), `bad_folder`, `bad_page`, `bad_id`, `bad_action`, `read_only` (403), `send_limit` (429).

## Spotify (Bearer capability of app `spotify`)

| Path | Notes |
|---|---|
| `GET /spotify/player` | Passive: does **not** extend the idle timer |
| `GET /spotify/devices` | |
| `GET /spotify/search?q=` | Tracks, max 10 |
| `POST /spotify/play` `{uri?|contextUri?, deviceId?}` `/pause` `/next` `/previous` | |
| `POST /spotify/volume` `{percent}` · `POST /spotify/transfer` `{deviceId, play}` | |

Error codes worth handling: `session_expired` (401), `read_only` (403), `send_limit` (429), `premium_required` (403), `no_active_device` (404), `rate_limited` (429).

## `GET /health`

`{ok, configured:{tokenKey, google, microsoft, notion, notionWrite, spotify, player}}` (booleans only, no values). Use it to check your setup.


## Origins (v2.1)
`FRONTEND_ORIGIN` (workspace) may call everything. `PLAYER_ORIGIN` (Spotify web player, must differ from `FRONTEND_ORIGIN`) may call only `/link/*`. CORS echoes the specific calling origin. `GET /health` also returns `configured.player`.
