# Relay API

All responses are JSON with `Cache-Control: no-store`. Except `/health` and `/oauth/*`, requests must come from `FRONTEND_ORIGIN` (CORS). `Origin` is a browser guard, **not** authentication: the real protections are the claim secret and the capability.

Errors look like `{ "error": "code" }`.

## Linking (per app)

| Method & path | Caller | Notes |
|---|---|---|
| `POST /link/start` `{app, access, claimHash}` | shared computer | `app` ∈ `gmail`,`spotify`; `access` ∈ `read`,`write` (Spotify: `write` only); `claimHash` = base64url SHA-256 of a 32-byte secret only the browser knows. Returns `{id, code, ttlMs}`. 503 `app_not_configured` if the vendor secrets are not set. |
| `GET /link/status/:id` header `X-Claim-Secret` | shared computer | `{status}`: `pending` `approved` `expired` `consumed` `cancelled`. Wrong/missing secret looks like `expired`. |
| `POST /link/claim/:id` header `X-Claim-Secret` | shared computer | One time. Returns `{cap, ttlMs, app, access}`. 409 otherwise. |
| `GET /link/info/:id` | phone | `{app, access, vendor, label, describe, ctx{ua,city,country}, ageSec, ttlMs}`. **Never includes the code.** |
| `POST /link/confirm/:id` `{code}` | phone | Code typed by the user. 403 `wrong_code` (`left` attempts), 410 `locked` after 3 wrong tries. Returns `{nonce}`. |
| `POST /link/cancel/:id` (optional `X-Claim-Secret`) | either | |

## OAuth (browser navigations)

| Path | Notes |
|---|---|
| `GET /oauth/google`, `GET /oauth/spotify` `?tx=&n=` | Starts consent. PKCE S256 + per-transaction `state`. No `access_type`, no `include_granted_scopes`. |
| `GET /oauth/google/callback`, `GET /oauth/spotify/callback` | Exchanges the code, verifies the granted scopes and lifetime, redirects the phone to `FRONTEND_URL#/p/<id>/done` or `/error?r=`. |

## Session

`POST /session/revoke` (Bearer capability): destroys the session and revokes the token at Google (Spotify has no revoke endpoint).

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

`{ok, configured:{tokenKey, google, spotify}}` (booleans only, no values). Use it to check your setup.
