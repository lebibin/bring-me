# Deploying Bring Me

Goal: a public URL you can send to friends. The client is a static Vite build; the server is a
Cloudflare Worker + Durable Object. Both fit comfortably in Cloudflare's free tier (salpakan's
signaling relay has run there for free since day one).

## Options considered

### Option A — one Cloudflare Worker serving everything ✅ (chosen, already wired)

The Worker serves the built client as **static assets** and keeps `/room/*` for the game
socket (`run_worker_first` routes those to the DO before the asset layer). One deploy, one URL,
and — the decisive part — **same origin**: the page's own host *is* the WebSocket host, so
there is no CORS, no baked-in server URL, and no origin allowlist to maintain. The client's
`wsBase()` and the server's `originAllowed()` already implement this.

- Deploy: `npm run build -w @bringme/client && cd server && npx wrangler deploy --env production`
- URL: `https://bringme.<account>.workers.dev`, upgradeable to `bringme.bibin.dev` later
- Config lives in `server/wrangler.toml` under `[env.production]` (kept out of the default env
  so local `wrangler dev` never needs `client/dist` to exist)

### Option B — GitHub Pages (client) + Cloudflare Worker (server)

How **salpakan** ships: Actions exports the web build to Pages (`salpakan.bibin.dev`), and a
separate `wrangler deploy` pushes the relay. It works, and Pages is a fine static host — but it
buys nothing here and costs real friction: the client must bake in the Worker's URL, the Worker
must allowlist the Pages origin (and again for every custom domain), and there are two deploy
pipelines to keep in step. Salpakan only tolerates this because its Worker is a dumb relay the
page barely talks to; Bring Me's server is the whole game.

### Option C — Cloudflare Pages (client) + Worker (server)

Same split as B with nicer tooling, same cross-origin tax. Cloudflare itself has been folding
Pages into Workers-with-assets — which is exactly Option A.

**Verdict:** A. B/C make sense only if the client ever needs a host the Worker can't be.

## One-time setup (manual, ~10 minutes)

1. **Cloudflare account** (the salpakan one works): note the **Account ID** (dashboard →
   Workers & Pages → right sidebar).
2. **API token**: dashboard → My Profile → API Tokens → Create → template *"Edit Cloudflare
   Workers"*. Scope it to the account.
3. **First deploy from this machine** (also claims the workers.dev name and runs the DO
   migration):
   ```
   npx wrangler login          # or set CLOUDFLARE_API_TOKEN
   npm run build -w @bringme/client
   cd server && npx wrangler deploy --env production
   ```
   The command prints the live URL — put it in the README.
4. **GitHub repo**: create it (private is fine), push `main`, then add two **Actions secrets**
   (repo → Settings → Secrets and variables → Actions):
   - `CLOUDFLARE_API_TOKEN` — the token from step 2
   - `CLOUDFLARE_ACCOUNT_ID` — from step 1

## Continuous deployment (GitHub Actions — already in the repo)

[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml), mirroring salpakan's
push-to-main-ships model:

- **Every push / PR** → `check` job: `npm run check` (strict tsc across all three packages)
  and `npm test` (the pure match/rules suite). The scripted bot matches need a live server, so
  they stay a local pre-push habit rather than a CI gate.
- **Push to `main`** → `deploy` job: build the client, `wrangler deploy --env production` via
  `cloudflare/wrangler-action`. Friends are on the new build seconds later.
- **Push a `v*` tag** → `release` job: deploys (tags may point at commits not on main) and cuts
  a **GitHub Release** with generated notes and the built client attached as a zip.

Suggested rhythm: push to `main` freely while testing with friends; tag `v0.1.0` when a build
feels like a keeper.

## After it's live

- **Smoke test** the URL from two devices (one off-LAN, e.g. phone on data): create a room,
  share the link, play a round. This exercises the same-origin socket, the DO migration, and
  hibernation on real infrastructure for the first time.
- **Custom domain** (optional): Workers → bringme → Settings → Domains & Routes → add
  `bringme.bibin.dev`. Same-origin design means zero code changes.
- **Known sharp edge**: there is no reconnect yet — a refresh mid-match rejoins as a spectator.
  That's the top roadmap item once friends start playing.
- **Cost watch**: DOs bill for wall-clock duration while awake. The tick interval only runs
  during live phases and rooms hibernate in the lobby, so a friends-scale rollout rounds to
  zero; if it ever grows, the free-tier duration allowance is the number to watch.
