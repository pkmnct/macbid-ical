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

Local image (current architecture):

```bash
npm run docker:build
```

Publish multi-arch (`linux/amd64`, `linux/arm64`) to Docker Hub:

```bash
npm run docker
```

Uses a `docker-container` buildx builder (`macbid-multiarch`); created automatically on first run. Requires `docker login`.

```bash
docker run -d \
  -p 3000:3000 \
  -p 3443:3443 \
  -v ./macbid-data:/usr/src/macbid-ical/data \
  -e ICAL_DATA_DIR=/usr/src/macbid-ical/data \
  -e ICAL_URL=0.0.0.0 \
  --env-file .env \
  pkmnct/macbid-ical:latest
```

Persistent files in the data directory:

```
data/
  tokens.json    # Mac.Bid session tokens
  tls/           # self-signed cert for the sign-in page
```

For production behind nginx, set `ICAL_PUBLIC_URL` and proxy the feed to port `3000` and `/login` to port `3443`. See your compose/nginx setup for details.

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

For 2FA in Docker, mount the `data` folder, publish ports `3000` (feed) and `3443` (sign-in, or proxy via nginx), then open `https://<host>:3443/<ICAL_UNIQUE_URL>/login`.

Pre-built image: [`pkmnct/macbid-ical`](https://hub.docker.com/r/pkmnct/macbid-ical)

## How it works

- Uses [`macbid-ts-api`](https://github.com/pkmnct/macbid-ts-api) for authentication, watchlist, active won items, and location data.
- Auth state is persisted in `data/tokens.json` from the state returned by `authenticate()` and `getAuthState()`.
- Pickup events are built in `pickupEvents.ts`: one event per building (same address) on the earliest abandon date, with that day's store hours and all warehouse slot codes for items at that building.
- The calendar includes a re-authentication reminder on refresh token expiry.

## Development

```bash
npm install
npm run dev      # run with ts-node
npm run build    # compile to JS
npm run lint
npm start        # run compiled output
```

## License

MIT
