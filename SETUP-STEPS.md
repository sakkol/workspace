# SETUP-STEPS: deploy v2 and update OAuth / Spotify / Cloudflare / GitHub

Your existing values (from v1) are already in `worker/wrangler.toml`: Worker `https://sakkol-relay.serdarakkol.workers.dev`, frontend `https://sakkol.github.io/workspace/`, Google client ID. Change them if yours differ.

Do the phases **in order**. You can stop after step 3 and have Gmail v2 working; Spotify (step 4) is optional.

---

## Phase 0: Replace the code (security fixes are already in it)

```bash
# in your existing local clone of the repo
git checkout -b v2
# delete everything except .git, then copy the contents of this package into the repo root
git add -A && git commit -m "Sakkol v2: multi-app launcher, Gmail read/write, Spotify, security fixes"
```
Do **not** push yet. The Worker must be configured first (steps 1-3), otherwise the new site will not work.

## Phase 1: Cloudflare Worker (multi-app relay + encryption key)

1. Install deps: `cd worker && npm ci`
2. Generate an encryption key for tokens at rest and store it as a **secret** (paste the output when prompted):
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   npx wrangler secret put TOKEN_KEY
   ```
3. Your Google client secret is already stored from v1. If you are unsure, set it again:
   `npx wrangler secret put GOOGLE_CLIENT_SECRET`
4. `wrangler.toml` already renames v1's `REDIRECT_URI` to `GOOGLE_REDIRECT_URI` (same value). **Do not** touch the `[[migrations]]` block or the class name `Store`.
5. Deploy: `npx wrangler deploy`
6. Check: open `https://sakkol-relay.serdarakkol.workers.dev/health`. Expect
   `{"ok":true,"configured":{"tokenKey":true,"google":true,"spotify":false}}`.
   Any `false` you need = a missing secret/variable.

## Phase 2: Frontend and GitHub

1. Repo **Settings > Secrets and variables > Actions > Variables**: `VITE_RELAY_URL` = `https://sakkol-relay.serdarakkol.workers.dev` (no trailing slash). It already exists from v1; the workflow now fails with a clear message if it is missing.
2. Repo **Settings > Pages > Source: GitHub Actions** (already set from v1).
3. Push: `git push -u origin v2`, open a pull request (CI runs the Worker tests), merge to `main`. The deploy workflow builds and publishes the site.
4. Optional but recommended: **Settings > Code security**: enable Dependabot alerts.

## Phase 3: Google Cloud (Gmail read/write)

Redirect URI does **not** change (`.../oauth/google/callback`).

1. https://console.cloud.google.com > your project > **Google Auth Platform > Data Access > Add or remove scopes**.
2. Make sure both are listed, then Save:
   - `https://www.googleapis.com/auth/gmail.readonly` (Read only mode)
   - `https://www.googleapis.com/auth/gmail.modify` (Read & write mode)
3. **Audience**: keep *Testing* and your Gmail address under **Test users**.
4. **APIs & Services > Library**: Gmail API must be enabled (it is from v1).
5. First unlock afterwards shows Google's consent screen again and an "unverified app" warning. That is normal in Testing mode: **Advanced > Go to Sakkol (unsafe) > Continue**, keep the permission ticked.

## Phase 4: Spotify (optional)

Needs: a Spotify **Premium** account for the app owner (Development Mode requirement), max 5 allowed users, search returns max 10 tracks. The Spotify account that plays music also needs Premium to be remote-controlled.

1. https://developer.spotify.com/dashboard > **Create app**.
   - Redirect URI: `https://sakkol-relay.serdarakkol.workers.dev/oauth/spotify/callback` (exact, https).
   - API: tick **Web API** only.
2. App **Settings > User Management**: add the name and email of each Spotify account that will log in.
3. Copy the **Client ID** into `worker/wrangler.toml` (`SPOTIFY_CLIENT_ID = "..."`).
4. Store the **Client Secret** as a secret:
   ```bash
   cd worker && npx wrangler secret put SPOTIFY_CLIENT_SECRET
   npx wrangler deploy
   ```
5. `/health` must now show `"spotify":true`. Commit the client ID change and push (the frontend needs no change).
6. Use: open Spotify on your phone or speaker and start any song once, then unlock Spotify from the shared computer. Music plays on **that device**; the shared computer is the remote.

If Spotify says the redirect/secret is invalid, re-check the exact URI. If the token exchange fails, see the note in `docs/SECURITY.md` (Assumptions) about client secret + PKCE.

## Phase 5: Verify, and optional staging

**Verify on production** with your own account (about 10 minutes):
1. Open the site on your computer: four tiles, nothing stored, no network call until you tap Unlock.
2. Gmail **Read only**: scan, type the code on the phone, approve on Google. Inbox loads; no Compose button.
3. Lock, unlock Gmail **Read & write**: send yourself a message, reply, star, archive, trash.
4. (If configured) Spotify: search, play, pause, volume, choose device.
5. Run the checklist in `docs/SECURITY.md`.
6. Clean up when done testing on a real shared machine: remove Sakkol at https://myaccount.google.com/permissions and https://www.spotify.com/account/apps.

**Optional staging** (test without touching production):
1. Uncomment the `[env.staging]` block in `worker/wrangler.toml`; set your computer's LAN IP (e.g. `192.168.1.50`) in `FRONTEND_ORIGIN` / `FRONTEND_URL` (no trailing slash on the origin).
2. Google Cloud: add `https://sakkol-relay-staging.serdarakkol.workers.dev/oauth/google/callback` as a second redirect URI (or use a second OAuth client). Spotify: add the staging callback too.
3. Secrets per environment: `npx wrangler secret put TOKEN_KEY --env staging` (also `GOOGLE_CLIENT_SECRET`, `SPOTIFY_CLIENT_SECRET`), then `npx wrangler deploy --env staging`.
4. `web/.env.local`: `VITE_RELAY_URL=https://sakkol-relay-staging.serdarakkol.workers.dev`, then `cd web && npm ci && npx vite --host`.
5. Open `http://192.168.1.50:5173` on the computer, scan with the phone on the same Wi-Fi.

**Rollback:** `git revert` the merge and let Pages redeploy; `cd worker && npx wrangler rollback`. The Durable Object cleans out incompatible v1 records automatically.

---

## Quick troubleshooting

| Symptom | Fix |
|---|---|
| `/health` shows `tokenKey:false` | Run `npx wrangler secret put TOKEN_KEY` and redeploy. All API calls return `server_misconfigured` until then |
| Site loads but every action fails / CORS error | `FRONTEND_ORIGIN` must equal the page origin exactly (`https://sakkol.github.io`, no path, no trailing slash) |
| Build fails "Set the repository variable VITE_RELAY_URL" | Add the variable in step Phase 2.1 |
| Google `redirect_uri_mismatch` | The URI in Google Cloud must equal `GOOGLE_REDIRECT_URI` exactly |
| Google "access blocked" | Your account is not in **Test users** |
| Phone shows "You did not grant the requested permission" | You unticked the Gmail permission on Google's screen; try again |
| Gmail write button missing | You unlocked *Read only*. Lock and unlock with *Read & write* |
| Spotify "not configured" | Phase 4 steps 3-4 and redeploy; check `/health` |
| Spotify 403 | Account not in User Management, or app owner's Premium lapsed |
| Spotify "No active device" | Open Spotify on the phone, play any song, press Refresh |
| `wrangler deploy` complains about Durable Objects | You changed the class name or migration block; restore them as shipped |
