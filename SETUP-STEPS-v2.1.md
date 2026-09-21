# SETUP-STEPS-v2.1: Spotify web player (plays in a browser tab)

Result: in the workspace click **Spotify → Web player**, a new tab opens with a QR code, you verify on your phone, and Spotify plays in that tab. No Spotify password on the computer.

**Order matters: A (Relay) → B (player site) → C (workspace) → D (Spotify) → E (use).**

## Why a GitHub *organization*?
All sites of one GitHub account (`sakkol.github.io/anything`) share **one origin**, and browsers only isolate by origin. The player loads Spotify's script, so it must not share an origin with your Gmail session. A free GitHub **organization** gets its own address (`<org>.github.io`), which is a different origin. The Relay refuses to run the player if both are on the same origin.

## A. Relay (Cloudflare Worker)
1. Pick the organization name now, for example `sakkol-player`. Your player origin will be `https://sakkol-player.github.io`.
2. In `worker/wrangler.toml`, under `[vars]`, add these two lines (do not replace other values; the update zip does **not** include this file so it will not overwrite your settings):
   ```toml
   PLAYER_ORIGIN = "https://sakkol-player.github.io"
   PLAYER_URL = "https://sakkol-player.github.io/player/"
   ```
   `PLAYER_ORIGIN`: no path, no trailing slash. `PLAYER_URL`: full page URL with trailing slash (repo named `player`).
3. Deploy: `cd worker && npm ci && npx wrangler deploy`
4. Check `https://sakkol-relay.serdarakkol.workers.dev/health` shows `"spotify":true` and `"player":true`.

## B. Player site (new repo in a new GitHub organization)
1. GitHub → **+ → New organization → Free** plan → name `sakkol-player` (use your chosen name) → "My personal account".
2. In the organization create a **public** repo named `player` (Pages on free organizations needs a public repo; it contains no secrets).
3. Unzip `sakkol-player-repo.zip`, push its contents to that repo's `main` branch.
4. Repo **Settings → Pages → Source: GitHub Actions**.
5. Repo **Settings → Secrets and variables → Actions → Variables** → new variable `VITE_RELAY_URL` = `https://sakkol-relay.serdarakkol.workers.dev` (no trailing slash).
6. Run the workflow (Actions → Deploy Spotify web player → Run workflow) or push again. The site appears at `https://sakkol-player.github.io/player/`.

## C. Workspace repo
1. Unzip `sakkol-v2.1-spotify-player-updates.zip` over your workspace repo.
2. Repo **Settings → Secrets and variables → Actions → Variables** → new variable `VITE_PLAYER_URL` = `https://sakkol-player.github.io/player/`.
3. Commit and push to `main`. The Spotify tile now offers **Web player (opens a new tab)** and **Remote control**.

## D. Spotify Developer Dashboard
1. Your app → **Settings** → in the APIs/SDKs used, tick **Web Playback SDK** (in addition to Web API).
2. Redirect URI: **unchanged** (`https://sakkol-relay.serdarakkol.workers.dev/oauth/spotify/callback`).
3. The Spotify account you play with must be **Premium** and listed under **User Management** (as before).

## E. Use it
1. Open an **incognito / InPrivate** window in **Chrome or Edge**, open the workspace, choose **Spotify → Web player → Unlock**.
2. In the new tab: scan the QR, type the code on the phone, approve on Spotify's page (you will see extra permissions: streaming, email, country).
3. Back in the tab press **Start player in this tab**, search, press ▶.
4. Press **DONE — lock** when finished. Every hour the token expires and you scan again (see "Things to know").

## Things to know (problems and limits)
- **Premium only**, and Spotify Development Mode limits still apply (owner Premium, at most 5 users, search returns 10 results).
- **One QR scan per hour.** The token lasts about an hour and, as you asked, the Relay keeps no refresh token, so it cannot renew it silently.
- **The token cannot be revoked early.** Spotify has no revoke endpoint. Pressing DONE deletes it from the tab, but anyone who copied it could use it until it expires (about an hour). Remove Sakkol at spotify.com/account/apps if in doubt.
- **The tab receives a token that can read your Spotify email and country** (Spotify's player requires those permissions).
- **Spotify's script runs in that tab.** It is isolated in its own origin and the CSP limits where the page can send data, but it is third-party code you do not control.
- **Keep-me-unlocked is off by default.** If you tick it, the token sits in the tab's session storage; a "reopen closed tab" (Ctrl+Shift+T) could bring it back until it expires. Leave it off on shared computers.
- **Auto-lock** after 30 minutes without a click or key press (client-side; change `IDLE_LOCK_MS` in `src/player/view.ts`).
- **DRM:** the player needs Widevine. Firefox private windows disable it; use Chrome/Edge incognito. The page tells you if DRM is missing.
- **Not tested against real Spotify and browsers** when this was written. The page CSP is a best effort: if playback fails, open the browser console (F12), find the line starting "Refused to …", and add that host to the CSP in the player repo's `index.html`.
- Remote control mode (plays on your phone/speaker) is unchanged and does not need any of this.

## Troubleshooting
| Symptom | Fix |
|---|---|
| Player tab says "player_not_isolated" | `PLAYER_ORIGIN` equals the workspace origin. Use the organization site |
| "The Relay does not accept this site" | `PLAYER_ORIGIN` must equal the player site's origin exactly (no path, no slash) |
| "The web player is not enabled" | `PLAYER_ORIGIN` / `PLAYER_URL` empty in `wrangler.toml`; redeploy the Worker |
| `/health` shows `"player":false` | Same as above, or Spotify secrets missing |
| Spotify page: "INVALID_CLIENT" or redirect error | Redirect URI in the dashboard must match exactly (unchanged from before) |
| Phone says permission not granted | Leave all permissions ticked |
| No sound / player never ready | Check the console for "Refused to …" (CSP), DRM message, or Premium |
| Workspace tile has no "Web player" option | `VITE_PLAYER_URL` variable missing; rerun the workspace deploy |
