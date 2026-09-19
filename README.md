# Sakkol Workspace v1 (Gmail read-only)

This repository contains the **Sakkol Workspace** frontend and its Cloudflare relay.

The frontend is kept in its own GitHub repository named **`workspace`** and is deployed as a GitHub Pages project site at:

**https://sakkol.github.io/workspace/**

The main Sakkol website remains in the separate `sakkol.github.io` repository. The two repositories do not need to be merged.

## Repository layout

- `web/` — static Vite frontend deployed to GitHub Pages
- `worker/` — Cloudflare Worker + Durable Object relay
- `.github/workflows/deploy.yml` — GitHub Pages deployment workflow

## 1. Google Cloud

1. Open Google Cloud Console and create/select a project.
2. Enable the **Gmail API**.
3. Configure the OAuth consent screen (Google Auth Platform).
4. Add only the scope:
   `https://www.googleapis.com/auth/gmail.readonly`
5. If the app is in Testing mode, add your Gmail address as a Test user.
6. Create an OAuth client ID for a **Web application**.
7. Set this exact authorized redirect URI:

   `https://sakkol-relay.YOUR-WORKERS-SUBDOMAIN.workers.dev/oauth/google/callback`

8. Keep the client secret private.

## 2. Cloudflare Relay

From `worker/`:

```bash
npm install
npx wrangler login
```

Edit `worker/wrangler.toml`:

- `FRONTEND_ORIGIN` is already set to `https://sakkol.github.io`
- `FRONTEND_URL` is already set to `https://sakkol.github.io/workspace/`
- replace `YOUR-WORKERS-SUBDOMAIN`
- replace `PASTE-CLIENT-ID.apps.googleusercontent.com`

Set the secret:

```bash
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

Then deploy:

```bash
npx wrangler deploy
```

The Worker URL must match the host used by `REDIRECT_URI`.

## 3. GitHub Pages for `workspace`

Push this repository as:

`https://github.com/sakkol/workspace`

In the repository:

1. Go to **Settings → Pages**.
2. Set the source to **GitHub Actions**.
3. Go to **Settings → Secrets and variables → Actions → Variables**.
4. Add a repository variable named `VITE_RELAY_URL`.
5. Set it to the Worker URL, with **no trailing slash**.
6. Push to `main`, or run the **Deploy frontend** workflow manually.

The resulting site is:

`https://sakkol.github.io/workspace/`

### Why the frontend uses `base: "./"`

`web/vite.config.ts` intentionally uses a relative Vite base:

```ts
export default defineConfig({ base: "./" });
```

That makes the generated frontend work under the project-site path `/workspace/` without hard-coding the repository path into the application. The app also uses hash routing (`#/p/...`), so the GitHub Pages project path does not require server-side rewrites.

## 4. Main site integration

Nothing needs to be copied into the `sakkol.github.io` repository.

From the main website, link to:

`/workspace/`

or:

`https://sakkol.github.io/workspace/`

GitHub Pages will serve the `workspace` repository independently at that path because it is a project site belonging to the same GitHub Pages user site.

## 5. Use it

Open:

`https://sakkol.github.io/workspace/`

Then:

1. The computer displays a QR code and six-digit confirmation code.
2. Scan the QR code with the phone.
3. Confirm that the code matches.
4. Google OAuth opens on the phone.
5. After authorization, the computer receives a short-lived capability and displays the Gmail inbox.
6. Click **DONE / SIGN OUT** when finished.

## 6. Security checklist

- No credential is stored in `localStorage`, `sessionStorage`, IndexedDB, or cookies.
- The Google access token remains server-side in the Durable Object.
- The browser receives only a short-lived capability.
- Sessions expire after 30 minutes maximum and 5 minutes of inactivity.
- OAuth uses PKCE.
- Gmail content is rendered as text, not injected as HTML.
- The relay rejects requests from origins other than `https://sakkol.github.io`.
- Never commit `GOOGLE_CLIENT_SECRET`.

## 7. Important deployment detail

The frontend repository is **`workspace`**, not `sakkol`.

The public URLs are therefore:

- Main site: `https://sakkol.github.io/`
- Workspace: `https://sakkol.github.io/workspace/`
- Relay: `https://sakkol-relay.YOUR-WORKERS-SUBDOMAIN.workers.dev/`

The Google OAuth redirect URI is the Worker callback, not the GitHub Pages URL.
