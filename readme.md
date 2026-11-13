# macbid-ical

Serve an iCal feed of your [Mac.Bid](https://www.mac.bid) watchlist and pickup windows for Apple Calendar, Google Calendar, or any app that subscribes to `.ics` URLs.

- Each watchlist item becomes an event at the lot's real close time (including late-bid extensions, as of the last feed refresh), with a link to the lot.
- Won items awaiting pickup become one event per pickup window and building, ending at the store's closing time or the abandon time, whichever comes first. The description lists the warehouse slot codes.
- A reminder event is added for when your Mac.Bid session expires.

## Requirements

- Node.js **22** or **>= 24** (or Docker)
- A Mac.Bid account

## Setup

### 1. Configure

Create a `.env` file:

```env
ICAL_UNIQUE_URL=pick-a-long-random-secret-path
```

Your Mac.Bid email and password can go in `.env` too (`MACBID_EMAIL`, `MACBID_PASSWORD`), or you can type them on the sign-in page.

| Variable | Required | Description |
|---|---|---|
| `ICAL_UNIQUE_URL` | Yes | Secret URL path for the feed. It is the only protection on the feed, so make it long and random |
| `MACBID_EMAIL` / `MACBID_PASSWORD` | No | Mac.Bid credentials (or enter them on the sign-in page) |
| `ICAL_PUBLIC_URL` | No | Public HTTPS URL, for sign-in behind a proxy and for the links in calendar events |
| `MACBID_VALIDATION_CODE` | No | SMS code for headless setups (the sign-in page is easier) |
| `ICAL_PORT` | No | HTTP port for the feed (default `3000`) |
| `ICAL_TLS_PORT` | No | HTTPS port for sign-in (default `3443`) |
| `ICAL_TLS_CERT` / `ICAL_TLS_KEY` | No | Your own certificate and key. Both must exist. Default: a self-signed pair generated in `data/tls/` |
| `ICAL_DATA_DIR` | No | Where tokens and certificates are kept (default `./data`) |
| `ICAL_URL` | No | Bind address (default `127.0.0.1`) |
| `ICAL_CACHE_SECONDS` | No | How long a built feed is reused (default `300`) |

### 2. Sign in (2FA)

Mac.Bid sends an SMS code on first login. Open the sign-in page over HTTPS (accept the self-signed certificate warning):

```
https://127.0.0.1:3443/<ICAL_UNIQUE_URL>/login
```

1. Enter your email and password (skipped if they are in `.env`).
2. Click **Send verification code**.
3. Enter the code from your phone and click **Sign in**.

Passwords typed on the page are held in memory for the SMS step (about 15 minutes) and never written to disk. Only session tokens are saved, in `data/tokens.json`. If a session is lost or expires, come back to the same page for a new code.

Sign-in only works over HTTPS. Without a certificate and without `ICAL_PUBLIC_URL`, the page answers `503` with setup instructions.

### 3. Subscribe

Add this address with your calendar app's "Subscribe to calendar" or "Add from URL":

```
http://127.0.0.1:3000/<ICAL_UNIQUE_URL>
```

The feed stays on plain HTTP so calendar apps are not blocked by the self-signed certificate.

## Docker

```bash
docker run -d \
  -p 3000:3000 \
  -v ./macbid-data:/usr/src/macbid-ical/data \
  -e ICAL_URL=0.0.0.0 \
  --env-file .env \
  --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true \
  pkmnct/macbid-ical:latest
```

Add `-p 3443:3443` if you supply a certificate (below), so the HTTPS sign-in page is reachable. Behind a TLS-terminating proxy, port `3000` is enough.

The image runs as a non-root user (uid 65532). On Linux, make the mounted folder writable by it: `chown 65532 macbid-data`.

The image has no `openssl`, so it cannot generate a certificate. Sign-in needs HTTPS, so provide it one of two ways:

- Supply a certificate: put `cert.pem` and `key.pem` in `data/tls/`, or set `ICAL_TLS_CERT` and `ICAL_TLS_KEY`. This opens the HTTPS port `3443`.
- Terminate TLS yourself in front of the container: set `ICAL_PUBLIC_URL` to the public HTTPS address and make sure your TLS-terminating proxy or load balancer sends `X-Forwarded-Proto: https`. Without that header the sign-in page answers `400` on port `3000`. Only trusted infrastructure should be able to reach port `3000`, since any client that can reach it directly can send that header.

Pre-built image: [`pkmnct/macbid-ical`](https://hub.docker.com/r/pkmnct/macbid-ical)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development, how it works, and the CI and publish workflows.

## License

MIT
