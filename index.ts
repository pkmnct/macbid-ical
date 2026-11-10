import { createHash } from "node:crypto";
import MacBid, { type AuthInfo, type SerializableAuthState } from "macbid-ts-api";
import http from "node:http";
import https from "node:https";
import { unlink } from "node:fs/promises";
import {
  clearAuthStateFile,
  hasActiveSession,
  loadAuthStateFile,
  mergePersistedAuthState,
  reconcileValidationCode,
  saveAuthStateFile,
  shouldPersistAuthState,
  toAuthInfo,
  type PersistedAuthState,
} from "./authStateFile.js";
import {
  credentialsFromForm,
  envCredentials,
  hasEnvCredentials,
  maskEmail,
  PendingCredentials,
  type MacbidCredentials,
} from "./credentialsFile.js";
import {
  loginPageModel,
  loginPageUrl,
  loginRedirectUrl,
  parseAppPath,
  readUrlEncodedForm,
  redactSecret,
  renderLoginPage,
  validationCodeSentMessage,
} from "./loginPage.js";
import {
  addAuthRequiredEvent,
  createMacbidCalendar,
  sendCalendarResponse,
} from "./feedCalendar.js";
import { buildPickupEvents } from "./pickupEvents.js";
import {
  authStatePath,
  ensureDataDir,
  legacyCredentialsPath,
  tlsDir,
} from "./dataDir.js";
import { loadTlsMaterials } from "./tls.js";
import { appVersion } from "./version.js";

// Load a local .env when there is one (development); containers pass real env vars
try {
  process.loadEnvFile();
} catch {
  // No .env file
}

const errorMessage = (error: unknown): string =>
  redactSecret(error instanceof Error ? error.message : String(error));

/** Mac.Bid is unreachable or failing: says nothing about whether we are signed in. */
const isUnavailable = (error: unknown): boolean => {
  if (!(error instanceof Error)) {
    return false;
  }
  return (
    ["MacBidUnavailableError", "FetchError", "TimeoutError", "AbortError"].includes(
      error.name
    ) ||
    (error instanceof TypeError && error.message === "fetch failed")
  );
};

function envValidationCode(): string | undefined {
  const code = process.env.MACBID_VALIDATION_CODE?.trim();
  return code || undefined;
}

function hasValidTokens(state: PersistedAuthState | null): boolean {
  return hasActiveSession(state);
}

function activeEmailHint(
  envCreds: MacbidCredentials | null,
  pending: PendingCredentials
): string | undefined {
  if (envCreds) {
    return maskEmail(envCreds.email);
  }
  const pendingCreds = pending.get();
  if (pendingCreds) {
    return maskEmail(pendingCreds.email);
  }
  return undefined;
}

(async () => {
  const feedSecret = process.env.ICAL_UNIQUE_URL;
  if (!feedSecret) {
    throw new Error("You must set ICAL_UNIQUE_URL");
  }
  if (feedSecret.length < 16) {
    console.warn(
      "ICAL_UNIQUE_URL is shorter than 16 characters. It is the only thing protecting the feed and the sign-in page, so use a long random value."
    );
  }

  const authStateFile = authStatePath();
  const legacyCredentialsFile = legacyCredentialsPath();
  const tlsPath = tlsDir();
  const api = new MacBid();
  const pendingCredentials = new PendingCredentials();

  await ensureDataDir();
  await unlink(legacyCredentialsFile).catch(() => undefined);

  interface FeedResult {
    /** False when the body is the "sign-in required" placeholder calendar. */
    signedIn: boolean;
    body: string;
  }

  const cacheSeconds = process.env.ICAL_CACHE_SECONDS
    ? parseInt(process.env.ICAL_CACHE_SECONDS, 10)
    : 300;
  let cachedFeed: { body: string; expires: number } | undefined;
  let pendingFeed: Promise<FeedResult> | undefined;

  // Sign-in attempts are limited for the whole server, not per client: behind
  // a proxy every request comes from the same address, and there is one user.
  const LOGIN_WINDOW_MS = 15 * 60 * 1000;
  const LOGIN_MAX_ATTEMPTS = 10;
  const loginAttempts: number[] = [];
  const loginRateLimited = (): boolean => {
    const now = Date.now();
    while (loginAttempts.length && loginAttempts[0]! < now - LOGIN_WINDOW_MS) {
      loginAttempts.shift();
    }
    if (loginAttempts.length >= LOGIN_MAX_ATTEMPTS) {
      return true;
    }
    loginAttempts.push(now);
    return false;
  };

  const pageOptions = (extra?: { message?: string; error?: string }) => ({
    credentialsFromEnv: hasEnvCredentials(),
    configuredEmail: activeEmailHint(envCredentials(), pendingCredentials),
    ...extra,
  });

  const loadPersistedAuth = async (): Promise<PersistedAuthState | null> => {
    const envCode = envValidationCode();
    const loaded = await loadAuthStateFile(authStateFile);
    const { state, cleared } = reconcileValidationCode(envCode, loaded);

    if (cleared) {
      console.log(
        "Validation code changed or removed; clearing saved auth state."
      );
      await clearAuthStateFile(authStateFile);
    }

    return state;
  };

  let persistedAuth = await loadPersistedAuth();

  const persistFromApi = async (
    apiState: SerializableAuthState,
    previous: PersistedAuthState | null = persistedAuth
  ): Promise<void> => {
    if (!shouldPersistAuthState(apiState, previous)) {
      return;
    }

    const envCode = envValidationCode();
    persistedAuth = mergePersistedAuthState(apiState, envCode, previous);
    await saveAuthStateFile(authStateFile, persistedAuth);
  };

  const resolveCredentials = (form?: URLSearchParams): MacbidCredentials => {
    const fromEnv = envCredentials();
    if (fromEnv) {
      return fromEnv;
    }

    const fromForm = form ? credentialsFromForm(form) : null;
    if (fromForm) {
      pendingCredentials.set(fromForm);
      return fromForm;
    }

    const pending = pendingCredentials.get();
    if (pending) {
      return pending;
    }

    throw new Error("Mac.Bid email and password are required.");
  };

  const buildAuthParams = (
    overrides: Partial<AuthInfo> = {},
    form?: URLSearchParams
  ): Partial<AuthInfo> => {
    const params: Partial<AuthInfo> = {
      ...toAuthInfo(persistedAuth),
      ...overrides,
    };

    const needsCredentials =
      !!overrides.validation_code ||
      !!form?.get("email") ||
      (!params.token && !params.refresh_token) ||
      hasEnvCredentials() ||
      !!pendingCredentials.get();

    if (needsCredentials) {
      const credentials = resolveCredentials(form);
      params.email = credentials.email;
      params.password = credentials.password;
    }

    if (!params.token && !params.refresh_token && !params.validation_code) {
      params.validation_code = envValidationCode();
    }

    return params;
  };

  const authenticateAndPersist = async (
    overrides: Partial<AuthInfo> = {},
    form?: URLSearchParams
  ): Promise<void> => {
    const previous = persistedAuth;
    try {
      await api.authenticate(buildAuthParams(overrides, form));
      await persistFromApi(api.getAuthState(), previous);
      if (hasValidTokens(persistedAuth)) {
        pendingCredentials.clear();
      }
    } catch (error) {
      if (isUnavailable(error)) {
        // Nothing changed on Mac.Bid's side: keep what is saved
        throw error;
      }
      await persistFromApi(api.getAuthState(), previous);
      throw error;
    }
  };

  const sendHtml = (res: http.ServerResponse, status: number, html: string) => {
    res.writeHead(status, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      // The page URL contains the secret path: never send it on as a referrer
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
    });
    res.end(html);
  };

  const handleLoginGet = async (res: http.ServerResponse) => {
    persistedAuth = await loadPersistedAuth();
    sendHtml(
      res,
      200,
      renderLoginPage(loginPageModel(persistedAuth, pageOptions()))
    );
  };

  const handleSendCode = async (
    req: http.IncomingMessage,
    res: http.ServerResponse
  ) => {
    try {
      persistedAuth = await loadPersistedAuth();
      const form = await readUrlEncodedForm(req);

      if (hasValidTokens(persistedAuth)) {
        sendHtml(
          res,
          200,
          renderLoginPage(
            loginPageModel(persistedAuth, pageOptions({
              message: "Already signed in. No verification code was sent.",
            }))
          )
        );
        return;
      }

      await resolveCredentials(form);

      await clearAuthStateFile(authStateFile);
      persistedAuth = null;
      await authenticateAndPersist({}, form);
      sendHtml(
        res,
        200,
        renderLoginPage(
          loginPageModel(persistedAuth, pageOptions({
            message: "Verification code sent. Check your phone.",
          }))
        )
      );
    } catch (error) {
      if (validationCodeSentMessage(error)) {
        sendHtml(
          res,
          200,
          renderLoginPage(
            loginPageModel(persistedAuth, pageOptions({
              message: "Verification code sent. Check your phone.",
            }))
          )
        );
        return;
      }

      console.error("Failed to send verification code:", errorMessage(error));
      sendHtml(
        res,
        500,
        renderLoginPage(
          loginPageModel(persistedAuth, pageOptions({
            error:
              error instanceof Error
                ? error.message
                : "Failed to send verification code.",
          }))
        )
      );
    }
  };

  const handleLoginPost = async (
    req: http.IncomingMessage,
    res: http.ServerResponse
  ) => {
    try {
      persistedAuth = await loadPersistedAuth();
      const form = await readUrlEncodedForm(req);
      const code = form.get("code")?.trim();

      if (!code) {
        sendHtml(
          res,
          400,
          renderLoginPage(
            loginPageModel(persistedAuth, pageOptions({
              error: "Enter the verification code from your phone.",
            }))
          )
        );
        return;
      }

      await authenticateAndPersist({ validation_code: code }, form);
      cachedFeed = undefined;
      sendHtml(
        res,
        200,
        renderLoginPage(
          loginPageModel(persistedAuth, pageOptions({
            message:
              "Signed in successfully. Your calendar feed will update automatically.",
          }))
        )
      );
    } catch (error) {
      console.error("Login failed:", errorMessage(error));
      sendHtml(
        res,
        400,
        renderLoginPage(
          loginPageModel(persistedAuth, pageOptions({
            error:
              error instanceof Error ? error.message : "Sign-in failed.",
          }))
        )
      );
    }
  };

  const authRequiredFeed = (reason: unknown): FeedResult => {
    console.error("Serving sign-in required calendar:", errorMessage(reason));
    const calendar = createMacbidCalendar();
    addAuthRequiredEvent(calendar, loginPageUrl());
    return { signedIn: false, body: calendar.toString() };
  };

  const buildFeed = async (): Promise<FeedResult> => {
    const renewUrl = loginPageUrl();
    persistedAuth = await loadPersistedAuth();

    if (
      !hasActiveSession(persistedAuth) &&
      !envCredentials() &&
      !pendingCredentials.get()
    ) {
      return authRequiredFeed("No active session and no credentials configured");
    }

    try {
      await authenticateAndPersist();

      const [favorites, activeItems, locations, buildings] = await Promise.all([
        api.get_watchlist(),
        api.get_active(),
        api.get_locations(),
        api.get_buildings(),
      ]);
      await persistFromApi(api.getAuthState());
      const refresh_token_expiration = await api.get_refresh_token_expiration();

      const calendar = createMacbidCalendar();

      // Stable ids let calendar apps update an event instead of duplicating it
      calendar.createEvent({
        id: "macbid-reauthentication",
        start: refresh_token_expiration,
        end: refresh_token_expiration,
        summary: "Mac.Bid Calendar Reauthentication Required",
        description: `Your Mac.Bid session for this calendar expires around this time. Sign in to renew:\n${renewUrl}`,
        url: renewUrl,
      });

      favorites.forEach((favorite) => {
        const eventDate = new Date(favorite.expected_close_date);
        eventDate.setHours(eventDate.getHours() + 1);

        calendar.createEvent({
          id: `macbid-watchlist-${favorite.auction_lot_id}`,
          start: eventDate,
          end: eventDate,
          summary: favorite.title,
          description: `This item is ending on Mac.bid at this time. Make sure to set a notification. The item is here: https://www.mac.bid/auction/${favorite.auction_number}/lot/${favorite.lot_number}`,
        });
      });

      for (const event of buildPickupEvents(activeItems, locations, buildings)) {
        const pickupKey = createHash("sha256")
          .update(`${event.summary}|${event.location}`)
          .digest("hex")
          .slice(0, 16);

        calendar.createEvent({
          id: `macbid-pickup-${pickupKey}`,
          summary: event.summary,
          start: event.start,
          end: event.end,
          timezone: event.timezone,
          location: event.location,
          description: event.description,
        });
      }

      return { signedIn: true, body: calendar.toString() };
    } catch (error) {
      if (isUnavailable(error)) {
        // An outage is not a sign-out: fail the request so calendar apps keep
        // what they have, instead of replacing it with a sign-in reminder
        throw error;
      }
      return authRequiredFeed(error);
    }
  };

  // Each build is a session check plus four Mac.Bid requests. Share one build
  // between concurrent requests and reuse it for a few minutes, so calendar
  // apps polling the feed cannot hammer the account.
  const getFeed = async (): Promise<string> => {
    if (cachedFeed && cachedFeed.expires > Date.now()) {
      return cachedFeed.body;
    }
    pendingFeed ??= buildFeed().finally(() => {
      pendingFeed = undefined;
    });
    const result = await pendingFeed;
    if (result.signedIn) {
      cachedFeed = {
        body: result.body,
        expires: Date.now() + cacheSeconds * 1000,
      };
    }
    return result.body;
  };

  const handleFeed = (req: http.IncomingMessage, res: http.ServerResponse) => {
    console.log("Valid incoming request, building calendar...");
    getFeed()
      .then((body) => {
        sendCalendarResponse(res, body, req.method === "HEAD");
        return;
      })
      .catch((error: unknown) => {
        console.error("Could not build the feed:", errorMessage(error));
        res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Could not load data from Mac.Bid\n");
      });
  };

  const proxiedHttps = (req: http.IncomingMessage): boolean => {
    const proto = req.headers["x-forwarded-proto"];
    const value = Array.isArray(proto) ? proto[0] : proto;
    return value?.split(",")[0]?.trim().toLowerCase() === "https";
  };

  // Behind nginx: ICAL_PUBLIC_URL is set and TLS is terminated at the proxy.
  // Serve login on the HTTP port instead of redirecting back to the public URL.
  const serveLoginOnHttpPort = (req: http.IncomingMessage): boolean =>
    !!process.env.ICAL_PUBLIC_URL?.trim() || proxiedHttps(req);

  const redirectLoginToHttps = (
    req: http.IncomingMessage,
    res: http.ServerResponse
  ) => {
    res.writeHead(307, { Location: loginRedirectUrl(req.url) });
    res.end();
  };

  const handleLoginRoute = (
    route: "login" | "login-send-code",
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): void => {
    if (req.method === "POST" && loginRateLimited()) {
      console.warn("Too many sign-in attempts; refusing for now");
      res.writeHead(429, {
        "Content-Type": "text/plain; charset=utf-8",
        "Retry-After": String(LOGIN_WINDOW_MS / 1000),
      });
      res.end("Too many sign-in attempts. Try again in a few minutes.\n");
      return;
    }

    if (route === "login") {
      if (req.method === "GET") {
        void handleLoginGet(res);
        return;
      }
      if (req.method === "POST") {
        void handleLoginPost(req, res);
        return;
      }
    }

    if (route === "login-send-code" && req.method === "POST") {
      void handleSendCode(req, res);
      return;
    }

    res.writeHead(405);
    res.end();
  };

  console.log(`macbid-ical v${appVersion}`);
  console.log("Authenticating on startup...");
  if (!hasActiveSession(persistedAuth) && !envCredentials()) {
    console.log(
      "No active Mac.Bid session. Sign in at:",
      redactSecret(loginPageUrl())
    );
  } else {
    try {
      await authenticateAndPersist();
      console.log("✓ Authentication successful on startup");
    } catch (error) {
      console.error(
        "✗ Authentication failed on startup:",
        errorMessage(error)
      );
      console.error("Sign in at:", redactSecret(loginPageUrl()));
    }
  }

  const httpPort = process.env.ICAL_PORT
    ? parseInt(process.env.ICAL_PORT, 10)
    : 3000;
  const tlsPort = process.env.ICAL_TLS_PORT
    ? parseInt(process.env.ICAL_TLS_PORT, 10)
    : 3443;
  const bind = process.env.ICAL_URL || "127.0.0.1";
  const tls = loadTlsMaterials(tlsPath);

  const servers: (http.Server | https.Server)[] = [];

  const httpServer = http
    .createServer((req, res) => {
      const route = parseAppPath(req.url, feedSecret);

      if (route === "feed") {
        if (req.method !== "GET" && req.method !== "HEAD") {
          res.writeHead(405);
          res.end();
          return;
        }
        handleFeed(req, res);
        return;
      }

      if (route === "login" || route === "login-send-code") {
        if (serveLoginOnHttpPort(req)) {
          handleLoginRoute(route, req, res);
        } else {
          redirectLoginToHttps(req, res);
        }
        return;
      }

      if (route !== null) {
        res.writeHead(405);
        res.end();
        return;
      }

      res.destroy();
    })
    .listen(httpPort, bind, () => {
      // The secret path is left out on purpose so it does not end up in the logs
      console.log(`iCal feed:  http://${bind === "0.0.0.0" ? "127.0.0.1" : bind}:${httpPort}/<ICAL_UNIQUE_URL>`);
    });
  servers.push(httpServer);

  if (tls) {
    const httpsServer = https
      .createServer({ cert: tls.cert, key: tls.key }, (req, res) => {
        const route = parseAppPath(req.url, feedSecret);

        if (route === "login" || route === "login-send-code") {
          handleLoginRoute(route, req, res);
          return;
        }

        if (route !== null) {
          res.writeHead(405);
          res.end();
          return;
        }

        res.writeHead(404);
        res.end();
      })
      .listen(tlsPort, bind, () => {
        const host = bind === "0.0.0.0" ? "127.0.0.1" : bind;
        console.log(`Sign in:    https://${host}:${tlsPort}/<ICAL_UNIQUE_URL>/login`);
      });
    servers.push(httpsServer);
  } else {
    console.log(
      "No TLS certificate and no openssl to make one: the HTTPS sign-in port is off. " +
        "Sign in through a TLS-terminating proxy (set ICAL_PUBLIC_URL), or set ICAL_TLS_CERT and ICAL_TLS_KEY."
    );
  }

  // Run as PID 1 in the container: exit promptly when Docker stops it
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      let open = servers.length;
      for (const server of servers) {
        server.close(() => {
          if (--open === 0) {
            process.exit(0);
          }
        });
        server.closeAllConnections();
      }
    });
  }
})();
