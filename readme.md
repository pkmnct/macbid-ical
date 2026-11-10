# macbid-ical

Serve an iCal feed of your [Mac.Bid](https://www.mac.bid) watchlist and pickup deadlines for Apple Calendar, Google Calendar, or any app that subscribes to `.ics` URLs.

Each watchlist item becomes a calendar event at its expected close time, with a link to the lot. Won items awaiting pickup are grouped into one event per building (same address), scheduled on the earliest abandon date using that location's open hours, with warehouse slot codes listed in the description. A reminder event is added for when your API session expires.

## Requirements

- Node.js **22** or **>= 24**
- A Mac.Bid account

## Setup

### 1. Configure environment

Create a `.env` file:

```env
ICAL_UNIQUE_URL=pick-a-long-random-secret-path
```

Credentials can be set in `.env` **or** entered on the HTTPS sign-in page (see below).

```env
MACBID_EMAIL=you@example.com
MACBID_PASSWORD=your-password
```

| Variable | Required | Description |
|---|---|---|
| `ICAL_UNIQUE_URL` | Yes | Secret URL path for the feed (acts as a password) |
| `MACBID_EMAIL` | No* | Mac.Bid account email (*or use sign-in page) |
| `MACBID_PASSWORD` | No* | Mac.Bid account password (*or use sign-in page) |
| `ICAL_PUBLIC_URL` | No | Public HTTPS base URL for sign-in links in calendar events |
| `MACBID_VALIDATION_CODE` | No | SMS 2FA code (optional; prefer the web sign-in page) |
| `ICAL_PORT` | No | HTTP port for the iCal feed (default: `3000`) |
| `ICAL_TLS_PORT` | No | HTTPS port for sign-in (default: `3443`) |
| `ICAL_TLS_CERT` | No | Path to TLS certificate (default: auto-generated self-signed in `data/tls/`) |
| `ICAL_TLS_KEY` | No | Path to TLS private key |
| `ICAL_DATA_DIR` | No | Persistent data directory (default: `./data`) |
| `ICAL_URL` | No | Bind address (default: `127.0.0.1`) |
| `ICAL_CACHE_SECONDS` | No | How long a built feed is reused before Mac.Bid is asked again (default: `300`) |

### 2. First-time login (2FA)

Mac.Bid requires SMS verification on first login. Open the **HTTPS** sign-in page in your browser (accept the self-signed certificate warning on first visit):

```
https://127.0.0.1:3443/<ICAL_UNIQUE_URL>/login
```

1. Enter your Mac.Bid email and password (skipped if `MACBID_EMAIL` / `MACBID_PASSWORD` are set in `.env`).
2. Click **Send verification code** and check your phone for the SMS.
3. Enter the code and click **Sign in**.

Credentials submitted on the sign-in page are kept **in memory only** during the SMS step (about 15 minutes), then discarded. Only API tokens are written to `data/tokens.json`. Email and password are never saved to disk unless you set them in `.env` / Docker secrets.

The iCal feed stays on plain HTTP (`ICAL_PORT`, default 3000) so calendar apps are not blocked by the self-signed certificate. Only the sign-in page uses HTTPS.

If the server runs behind Docker or a reverse proxy, set `ICAL_PUBLIC_URL` to your public HTTPS origin (e.g. `https://macbid-ical.example.com`). That URL is included in the calendar re-authentication reminder event.

**Alternative:** set `MACBID_VALIDATION_CODE` in `.env` and restart (useful for fully headless setups). The saved `device_id` is reused on the next attempt, so a second SMS is not sent unless you request a new code from the sign-in page.

To request a fresh code from scratch, use **Send new verification code** on the sign-in page, or delete `data/tokens.json` and start over.

> Building something with a UI? You can pass the code in the same session via `validation_code` — see [`macbid-ts-api` README](https://github.com/pkmnct/macbid-ts-api#two-factor-authentication).

### 3. Subscribe in your calendar

Once running:

```
http://127.0.0.1:3000/<ICAL_UNIQUE_URL>
```

Use your calendar app's "Subscribe to calendar" or "Add from URL" feature with that address.

> **Security:** `ICAL_UNIQUE_URL` is the only protection on your feed. Use a long random value and do not share the URL.

## Docker

Local image (current architecture), then the same checks CI runs against it:

```bash
npm run docker:build
scripts/smoke-test.sh
```

The published image is built and pushed by GitHub Actions (see [Automation](#automation)); `npm run docker` still pushes a multi-arch build by hand and requires `docker login`.

```bash
docker run -d \
  -p 3000:3000 \
  -v ./macbid-data:/usr/src/macbid-ical/data \
  -e ICAL_URL=0.0.0.0 \
  --env-file .env \
  --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true \
  pkmnct/macbid-ical:latest
```

The image is distroless (no shell, package manager or `openssl`), runs as a non-root user (uid 65532) and writes only to the data directory. On Linux, make the mounted folder writable by that user (`chown 65532 macbid-data`). Nothing from the build machine's working directory is copied in except the source files: `.dockerignore` is an allowlist.

Because the image has no `openssl`, it cannot generate the self-signed certificate. The HTTPS sign-in port (`3443`) is only opened when a certificate already exists in `data/tls/` or `ICAL_TLS_CERT` / `ICAL_TLS_KEY` point at one. Otherwise sign in through a TLS-terminating proxy with `ICAL_PUBLIC_URL` set. With neither, sign-in is turned off: the sign-in URL answers `503` with these instructions rather than redirecting to a port that is not listening.

Persistent files in the data directory:

```
data/
  tokens.json    # Mac.Bid session tokens
  tls/           # self-signed cert for the sign-in page
```

For production behind nginx, set `ICAL_PUBLIC_URL` and proxy everything to port `3000`; the sign-in page is served there when `ICAL_PUBLIC_URL` is set.

In `docker-compose.yml`, always quote URLs — YAML treats `//` as a comment, so an unquoted `https://example.com:8443` becomes `https:/` inside the container:

```yaml
environment:
  ICAL_PUBLIC_URL: "https://example.com:8443"
```

If compose builds the URL from `${DOMAIN}`, set `DOMAIN` in the same `.env` file compose reads (the `DOMAIN variable is not set` warning means it is empty).

Example nginx config (terminates TLS, proxies everything to the HTTP feed port; login works via `X-Forwarded-Proto`):

```nginx
location / {
    proxy_pass http://macbid-ical:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

Do **not** proxy login to port `3000` without `X-Forwarded-Proto` on older images. Current versions also skip the redirect when `ICAL_PUBLIC_URL` is set (TLS terminated at nginx).

For 2FA in Docker, mount the `data` folder and open `https://<your public host>/<ICAL_UNIQUE_URL>/login` through the proxy.

Pre-built image: [`pkmnct/macbid-ical`](https://hub.docker.com/r/pkmnct/macbid-ical)

## How it works

- Uses [`macbid-ts-api`](https://github.com/pkmnct/macbid-ts-api) for authentication, watchlist, active won items, and location data.
- Auth state is persisted in `data/tokens.json` from the state returned by `authenticate()` and `getAuthState()`.
- Pickup events are built in `pickupEvents.ts`: one event per building (same address) on the earliest abandon date, with that day's store hours and all warehouse slot codes for items at that building.
- The calendar includes a re-authentication reminder on refresh token expiry.

## Development

```bash
npm install
npm run dev      # compile, then run (reads .env)
npm run typecheck
npm run build    # compile to JS
npm run lint
npm start        # run compiled output
```

## Automation

- **CI** (`.github/workflows/ci.yml`): lint, type-check and build on Node 22, 24 and 26, `npm audit` of production dependencies, and an image build with `scripts/smoke-test.sh` on every pull request and push to `main`.
- **Publish** (`.github/workflows/publish.yml`): builds, smoke-tests and pushes `pkmnct/macbid-ical:latest` plus a dated tag for amd64 and arm64 on every push to `main`, every Wednesday (so base-image security patches arrive without a code change), and on demand. Needs the repository secrets `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN`.
- **Dependabot** (`.github/dependabot.yml`): weekly grouped updates for npm, the Docker base image and GitHub Actions. Patch and minor npm and Docker updates merge themselves once CI passes; this relies on branch protection requiring the CI checks. Those merges do not start a publish run by themselves, so they ship with the next weekly rebuild.

Mac.Bid's API at `api.macdiscount.com` is the only host the server contacts.

## License

MIT
