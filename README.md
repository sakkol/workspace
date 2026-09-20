# Sakkol Workspace (v2)

Unlock your apps on an **untrusted shared computer** using your **trusted phone**. Your Google/Spotify password is never typed on the shared computer, and no login credential is stored in the shared browser.

| App | v2 status |
|---|---|
| Gmail | read-only **or** read & write (send, reply, star, archive, trash) |
| Spotify | search + remote control of playback on your own devices |
| Google Drive, Notion | "coming soon" tiles (no backend yet) |

**Start here:** [`SETUP-STEPS.md`](SETUP-STEPS.md) (deploy + Google/Spotify/Cloudflare/GitHub configuration, all phases).
Then: [`docs/SECURITY.md`](docs/SECURITY.md) · [`docs/API.md`](docs/API.md) · [`docs/SECURITY-REVIEW-v1.md`](docs/SECURITY-REVIEW-v1.md).

## How it works

1. On the shared computer you tap **Unlock Gmail** (or Spotify). It shows a QR code and a 6-digit code.
2. On your phone you scan the QR, see *what* is being unlocked and *where the request came from*, and **type** the 6-digit code.
3. The phone goes to Google's / Spotify's own consent page. The Relay (a Cloudflare Worker) receives the token. **The token never reaches the shared browser.**
4. The shared browser claims a random, short-lived **capability** (held only in JavaScript memory, one per app) and uses it against the Relay.
5. **DONE** (or a timer, or a page refresh) ends the session. The Relay enforces expiry itself.

## Layout

```
web/      static frontend (TypeScript + Vite)  -> GitHub Pages
worker/   Cloudflare Worker "Relay" + Durable Object -> workers.dev
docs/     API, security architecture, v1 review
SETUP-STEPS.md
```

Adding an app later (Drive, Notion): one entry in `worker/src/apps.ts`, a vendor in `worker/src/vendors.ts` if it is a new OAuth provider, a route file, and a tile in `web/src/apps/registry.ts`.

## Commands

```bash
cd worker && npm ci && npm test && npm run typecheck   # unit + router tests
cd web    && npm ci && npm test && npm run build       # needs VITE_RELAY_URL for the build
```
