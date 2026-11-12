# Contributing

## Development

```bash
npm install
npm run dev        # compile, then run (reads .env)
npm run typecheck
npm run lint
npm test           # time conversion and pickup-day tests
npm run build      # compile to JS
npm start          # run compiled output
```

Run lint, typecheck, tests and build before opening a pull request. CI runs the same checks.

## How it works

- [`macbid-ts-api`](https://github.com/pkmnct/macbid-ts-api) (2.x) handles authentication, the watchlist, active won items, locations and buildings.
- Session state is saved to `data/tokens.json` (mode `0600`, written through a temporary file and renamed). Email and password are only held in memory.
- Feed builds, startup sign-in and web sign-in run one at a time (`withAuthLock` in `index.ts`), so they cannot overwrite each other's saved state.
- Only a failed sign-in becomes the "Sign-In Required" all-day event. Any other failure (bad response, Mac.Bid down) returns `502`, so calendar apps keep their existing events.
- Pickup events are built in `pickupEvents.ts`: one event per resolved pickup window and building, from the store's hours, ending at closing time or the abandon time, whichever is first. Times are written as UTC instants.
- Sign-in (`loginPage.ts`) is served only over HTTPS:
  - on the TLS port (`3443`), when a certificate exists in `data/tls/` or `ICAL_TLS_CERT` / `ICAL_TLS_KEY` are set;
  - on the HTTP port, when `ICAL_PUBLIC_URL` is set and the proxy sends `X-Forwarded-Proto: https`.

  A request to the HTTP port without that header gets `400` if `ICAL_PUBLIC_URL` is set. Otherwise it is redirected to the TLS port, or answered with `503` when there is no certificate.
- Sign-in attempts are rate limited for the whole server: 10 code attempts and 5 send-code requests per 15 minutes.
- The only host the server contacts is Mac.Bid's API, `api.macdiscount.com`.

## Docker

Build the image for this machine and run the same checks CI runs:

```bash
npm run docker:build
scripts/smoke-test.sh
```

`npm run docker` pushes a multi-arch build by hand and needs `docker login`. Normally GitHub Actions publishes the image.

The image is multi-stage and distroless (no shell, package manager or `openssl`), runs as uid 65532 and writes only to the data directory. `.dockerignore` is an allowlist of the manifests and `*.ts` files, so `.env`, tokens, TLS keys and `.git` cannot be copied in. Keep it that way when adding files the build needs.

Files in the data directory:

```
data/
  tokens.json    # Mac.Bid session tokens
  tls/           # self-signed cert and key for the sign-in page
```

## Automation

- **CI** (`.github/workflows/ci.yml`): lint, type-check, tests and build on Node 22, 24 and 26, `npm audit` of production dependencies, and an image build with `scripts/smoke-test.sh` on every pull request and push to `main`.
- **Publish** (`.github/workflows/publish.yml`): runs lint, typecheck and tests, then builds, smoke-tests and pushes `pkmnct/macbid-ical:latest` plus a dated tag for amd64 and arm64 on every push to `main`, every Wednesday (so base-image security patches arrive without a code change), and on demand. Needs the repository secrets `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN`.
- **Dependabot** (`.github/dependabot.yml`): weekly grouped updates for npm, the Docker base image and GitHub Actions. Patch and minor npm and Docker updates merge themselves once CI passes; this relies on branch protection on `main` requiring the CI checks and "Allow auto-merge" being on. Those merges do not start a publish run by themselves, so they ship with the next weekly rebuild.
