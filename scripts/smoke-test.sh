#!/usr/bin/env bash
# Start the image the way the deployment runs it (read-only, no capabilities,
# no network, only /tmp and the data directory writable) and check startup and
# routing. It has no Mac.Bid session and no way out, so the feed must be the
# "sign-in required" calendar and nothing may crash.
#
# Usage: scripts/smoke-test.sh [image]
set -euo pipefail

image="${1:-macbid-ical}"
secret="smoke-test-$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
network="macbid-smoke-$$"
name="macbid-smoke-$$"

cleanup() {
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker network create --internal "$network" >/dev/null
docker run -d --name "$name" --network "$network" \
  --read-only --tmpfs /tmp \
  --tmpfs /usr/src/macbid-ical/data:uid=65532,gid=65532,mode=700 \
  --cap-drop ALL --security-opt no-new-privileges:true \
  --memory 256m --pids-limit 100 \
  -e ICAL_UNIQUE_URL="$secret" -e ICAL_URL=0.0.0.0 -e ICAL_PORT=3000 \
  -e ICAL_PUBLIC_URL="https://calendar.example.test" \
  "$image" >/dev/null

# The image has no shell or curl, so probe it with node from inside the container.
# Prints the status code, then the body.
# Set NO_PROXY_HEADER=1 to leave out the X-Forwarded-Proto header a proxy adds.
probe() {
  docker exec -e NO_PROXY_HEADER="${NO_PROXY_HEADER:-}" "$name" /nodejs/bin/node -e '
    const [method, path, body] = process.argv.slice(1);
    const req = require("node:http").request(
      { host: "127.0.0.1", port: 3000, method, path, timeout: 20000,
        headers: { ...(process.env.NO_PROXY_HEADER ? {} : { "X-Forwarded-Proto": "https" }), ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) } },
      (res) => { let out = ""; res.on("data", (d) => (out += d)); res.on("end", () => console.log(res.statusCode + "\n" + out)); }
    );
    req.on("error", () => console.log("closed"));
    req.end(body);
  ' "$@"
}
status() { probe "$@" | head -n 1; }

fail() {
  echo "FAIL $1"
  docker logs "$name" || true
  exit 1
}

expect() {
  local label="$1" want="$2" got="$3"
  [ "$got" = "$want" ] || fail "$label: wanted $want, got $got"
  echo "ok   $label ($got)"
}

for _ in $(seq 1 20); do
  docker logs "$name" 2>&1 | grep -q "iCal feed:" && break
  sleep 0.5
done

expect "runs as non-root" "65532" "$(docker exec "$name" /nodejs/bin/node -p 'process.getuid()')"
expect "wrong path is dropped" "closed" "$(status GET /)"
expect "near-miss path is dropped" "closed" "$(status GET "/${secret}x")"
expect "POST to the feed is refused" "405" "$(status POST "/$secret")"

feed="$(probe GET "/$secret")"
expect "feed answers without a session" "200" "$(echo "$feed" | head -n 1)"
echo "$feed" | grep -q "BEGIN:VCALENDAR" || fail "feed is not a calendar"
echo "$feed" | grep -q "Mac.Bid Sign-In Required" || fail "feed has no sign-in reminder"
echo "ok   feed is the sign-in required calendar"

page="$(probe GET "/$secret/login")"
expect "sign-in page is served behind a proxy" "200" "$(echo "$page" | head -n 1)"
echo "$page" | grep -q "<form" || fail "sign-in page has no form"

# Straight to the HTTP port, not through the proxy: never serve the form in cleartext
direct="$(NO_PROXY_HEADER=1 probe GET "/$secret/login")"
expect "sign-in is refused without the proxy header" "400" "$(echo "$direct" | head -n 1)"
if echo "$direct" | grep -q "<form"; then fail "sign-in form served without the proxy header"; fi

expect "empty code is rejected" "400" "$(status POST "/$secret/login" "code=")"
for _ in $(seq 1 9); do status POST "/$secret/login" "code=" >/dev/null; done
expect "sign-in attempts are rate limited" "429" "$(status POST "/$secret/login" "code=")"

expect "still running" "true" "$(docker inspect -f '{{.State.Running}}' "$name")"

if docker logs "$name" 2>&1 | grep -q "$secret"; then
  fail "the secret path appears in the logs"
fi
echo "ok   secret path is not logged"
