import { createHash } from "node:crypto";
import MacBid, {
  MacBidAuthError,
  MacBidUnavailableError,
  type AuthInfo,
  type SerializableAuthState,
} from "macbid-ts-api";
import http from "node:http";
import https from "node:https";
import {
  clearAuthStateFile,
  hasActiveSession,
  hasPersistedTokens,
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
  feedPublicBaseUrl,
  loginPageModel,
  loginPageUrl,
  loginRedirectUrl,
  parseAppPath,
  portFromEnv,
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
  migrateLegacyFiles,
  tlsDir,
} from "./dataDir.js";
import { loadTlsMaterials } from "./tls.js";
import { appVersion } from "./version.js";
import { resolveWatchlistCloses } from "./watchlistCloseTimes.js";

// Load a local .env when there is one (development); containers pass real env vars
try {
  process.loadEnvFile();
} catch {
  // No .env file
}

/** Wraps a failure to authenticate, so it is not confused with a failed data fetch. */
class SignInRequiredError extends Error {
  constructor(readonly reason: unknown) {
    super("Mac.Bid sign-in required");
  }
}

const errorMessage = (error: unknown): string =>
  redactSecret(error instanceof Error ? error.message : String(error));

/** Mac.Bid is unreachable or failing: says nothing about whether we are signed in. */
const isUnavailable = (error: unknown): boolean =>
  error instanceof MacBidUnavailableError;

function envValidationCode(): string | undefined {
  const code = process.env.MACBID_VALIDATION_CODE?.trim();
  return code || undefined;
}

function cacheSecondsFromEnv(): number {
  const DEFAULT = 300;
  const raw = process.env.ICAL_CACHE_SECONDS?.trim();
  if (!raw) {
    return DEFAULT;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    console.warn(
      `ICAL_CACHE_SECONDS must be a number of seconds (got ${JSON.stringify(raw)}); using ${DEFAULT}.`
    );
    return DEFAULT;
  }
  return value;
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
  const api = new MacBid();
  const pendingCredentials = new PendingCredentials();

  await ensureDataDir();
  await migrateLegacyFiles();

  const tls = loadTlsMaterials(tlsDir());
  const publicUrlConfigured = !!process.env.ICAL_PUBLIC_URL?.trim();
  // Without a certificate or a TLS proxy there is nowhere safe to sign in
  const signInAvailable = !!tls || publicUrlConfigured;
  const signInUrl = (): string =>
    signInAvailable
      ? loginPageUrl()
      : `${feedPublicBaseUrl()}/${feedSecret}/login`;

  interface FeedResult {
    /** False when the body is the "sign-in required" placeholder calendar. */
    signedIn: boolean;
    body: string;
  }

  const cacheSeconds = cacheSecondsFromEnv();
  let cachedFeed: { body: string; expires: number } | undefined;
  let pendingFeed: Promise<FeedResult> | undefined;

  // Feed builds, sign-in and startup all share one Mac.Bid client and the
  // saved auth state. Run them one at a time so none sees another's half-done
  // state or saves over it.
  let authQueue: Promise<unknown> = Promise.resolve();
  const withAuthLock = <T>(task: () => Promise<T>): Promise<T> => {
    const run = authQueue.then(task);
    authQueue = run.catch(() => undefined);
    return run;
  };

  // Sign-in attempts are limited for the whole server, not per client: behind
  // a proxy every request comes from the same address, and there is one user.
  const LOGIN_WINDOW_MS = 15 * 60 * 1000;
  // Separate budgets: each send-code texts the owner and invalidates the
  // previous code, so it gets the tighter one, and asking for a few new codes
  // never uses up the attempts for typing them in
  const makeLimiter = (max: number) => {
    const attempts: number[] = [];
    return {
      limited: (): boolean => {
        const now = Date.now();
        while (attempts.length && attempts[0]! < now - LOGIN_WINDOW_MS) {
          attempts.shift();
        }
        return attempts.length >= max;
      },
      // Counted when the request arrives, before any await, so a burst of
      // parallel requests cannot all pass the check
      record: () => {
        attempts.push(Date.now());
      },
      reset: () => {
        attempts.length = 0;
      },
      // Seconds until the oldest attempt leaves the window and one slot frees
      retryAfterSeconds: (): number =>
        Math.max(
          1,
          Math.ceil(((attempts[0] ?? Date.now()) + LOGIN_WINDOW_MS - Date.now()) / 1000)
        ),
    };
  };
  const codeLimiter = makeLimiter(10);
  const sendCodeLimiter = makeLimiter(5);

  const pageOptions = (extra?: { message?: string; error?: string }) => ({
    credentialsFromEnv: hasEnvCredentials(),
    hasPendingCredentials: !!pendingCredentials.get(),
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

  /** Env credentials, then ones typed in the form, then ones kept from "send code". */
  const resolveCredentials = (form?: URLSearchParams): MacbidCredentials => {
    const credentials =
      envCredentials() ??
      (form ? credentialsFromForm(form) : null) ??
      pendingCredentials.get();
    if (!credentials) {
      throw new Error(
        "Enter your Mac.Bid email and password along with the code (the server no longer has them)."
      );
    }
    return credentials;
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

  /** Call only inside withAuthLock. */
  const authenticateAndPersist = async (
    overrides: Partial<AuthInfo> = {},
    form?: URLSearchParams
  ): Promise<void> => {
    const previous = persistedAuth;
    try {
      await api.authenticate(buildAuthParams(overrides, form));
      await persistFromApi(api.getAuthState(), previous);
      if (hasActiveSession(persistedAuth)) {
        pendingCredentials.clear();
      }
    } catch (error) {
      if (isUnavailable(error)) {
        // Nothing changed on Mac.Bid's side: keep what is saved
        throw error;
      }
      if (
        hasPersistedTokens(previous) &&
        !hasPersistedTokens(api.getAuthState())
      ) {
        // The library dropped the session (its refresh was refused): the
        // saved copy is dead too. Forget it, or the sign-in page would keep
        // reporting it as active and refuse to send a new code.
        await clearAuthStateFile(authStateFile);
        persistedAuth = null;
        await persistFromApi(api.getAuthState(), null);
      } else {
        await persistFromApi(api.getAuthState(), previous);
      }
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

  const sendPage = (
    res: http.ServerResponse,
    status: number,
    extra?: { message?: string; error?: string }
  ) => {
    sendHtml(
      res,
      status,
      renderLoginPage(loginPageModel(persistedAuth, pageOptions(extra)))
    );
  };

  const handleLoginGet = async (res: http.ServerResponse) => {
    try {
      await withAuthLock(async () => {
        persistedAuth = await loadPersistedAuth();
      });
      sendPage(res, 200);
    } catch (error) {
      console.error("Could not render the sign-in page:", errorMessage(error));
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Could not render the sign-in page\n");
    }
  };

  const handleSendCode = async (
    req: http.IncomingMessage,
    res: http.ServerResponse
  ) => {
    try {
      const form = await readUrlEncodedForm(req);

      const message = await withAuthLock(async () => {
        persistedAuth = await loadPersistedAuth();
        if (hasActiveSession(persistedAuth)) {
          return "Already signed in. No verification code was sent.";
        }

        const credentials = resolveCredentials(form);

        // Start the sign-in over: a pending device_id would make the library
        // refuse to send another code. What is saved is only replaced once
        // Mac.Bid has accepted the email and password and sent a code.
        api.resetSession();
        try {
          await api.authenticate({
            email: credentials.email,
            password: credentials.password,
          });
        } catch (error) {
          if (!validationCodeSentMessage(error)) {
            throw error;
          }
        }

        await persistFromApi(api.getAuthState(), null);
        if (hasPersistedTokens(persistedAuth)) {
          pendingCredentials.clear();
          cachedFeed = undefined;
          return "Signed in successfully. Your calendar feed will update automatically.";
        }
        if (!hasEnvCredentials()) {
          pendingCredentials.set(credentials);
        }
        return "Verification code sent. Check your phone.";
      });

      sendPage(res, 200, { message });
    } catch (error) {
      console.error("Failed to send verification code:", errorMessage(error));
      sendPage(res, isUnavailable(error) ? 502 : 400, {
        error:
          error instanceof Error
            ? error.message
            : "Failed to send verification code.",
      });
    }
  };

  const handleLoginPost = async (
    req: http.IncomingMessage,
    res: http.ServerResponse
  ) => {
    try {
      const form = await readUrlEncodedForm(req);
      const code = form.get("code")?.trim();

      if (!code) {
        sendPage(res, 400, {
          error: "Enter the verification code from your phone.",
        });
        return;
      }

      await withAuthLock(async () => {
        persistedAuth = await loadPersistedAuth();
        await authenticateAndPersist({ validation_code: code }, form);
        cachedFeed = undefined;
      });
      codeLimiter.reset();
      sendCodeLimiter.reset();
      sendPage(res, 200, {
        message:
          "Signed in successfully. Your calendar feed will update automatically.",
      });
    } catch (error) {
      console.error("Login failed:", errorMessage(error));
      sendPage(res, 400, {
        error: error instanceof Error ? error.message : "Sign-in failed.",
      });
    }
  };

  const authRequiredFeed = (reason: unknown): FeedResult => {
    console.error("Serving sign-in required calendar:", errorMessage(reason));
    const calendar = createMacbidCalendar();
    addAuthRequiredEvent(calendar, signInUrl());
    return { signedIn: false, body: calendar.toString() };
  };

  const buildFeed = async (): Promise<FeedResult> => {
    const renewUrl = signInUrl();

    let data;
    try {
      data = await withAuthLock(async () => {
        persistedAuth = await loadPersistedAuth();

        // A code was already texted and is waiting to be typed in: logging in
        // again would text a new one on every poll and invalidate that one
        const awaitingCode =
          !!persistedAuth?.device_id &&
          !hasPersistedTokens(persistedAuth) &&
          !envValidationCode();
        if (
          !hasActiveSession(persistedAuth) &&
          (awaitingCode || (!envCredentials() && !pendingCredentials.get()))
        ) {
          return null;
        }

        try {
          await authenticateAndPersist();
        } catch (error) {
          throw new SignInRequiredError(error);
        }
        let fetched;
        try {
          const [favorites, ...rest] = await Promise.all([
            api.get_watchlist(),
            api.get_active(),
            api.get_locations(),
            api.get_buildings(),
          ]);
          // The watchlist's own close dates are wrong: each lot's end_time is
          // the real close (see watchlistCloseTimes.ts). Inside this try, so a
          // sign-in failure here is handled like any other
          const watchlist = await resolveWatchlistCloses(favorites, api.get_lot);
          fetched = [watchlist, ...rest] as const;
        } catch (error) {
          if (error instanceof MacBidAuthError) {
            // The library has dropped the session; forget the saved copy too,
            // or the sign-in page would keep reporting it as active and refuse
            // to send a new code
            await clearAuthStateFile(authStateFile);
            persistedAuth = null;
            throw new SignInRequiredError(error);
          }
          throw error;
        }
        const [watchlist, activeItems, locations, buildings] = fetched;
        await persistFromApi(api.getAuthState());
        const refreshTokenExpiration = await api.get_refresh_token_expiration();
        return {
          watchlist,
          activeItems,
          locations,
          buildings,
          refreshTokenExpiration,
        };
      });
    } catch (error) {
      // Only a failed sign-in becomes the sign-in reminder. Anything else (a
      // bad response, a bug) fails the request, so calendar apps keep what they
      // have instead of replacing it with a misleading reminder
      if (!(error instanceof SignInRequiredError)) {
        throw error;
      }
      if (isUnavailable(error.reason)) {
        throw error.reason;
      }
      return authRequiredFeed(error.reason);
    }

    if (!data) {
      return authRequiredFeed("No active session and no credentials configured");
    }

    const calendar = createMacbidCalendar();

    // Stable ids let calendar apps update an event instead of duplicating it
    calendar.createEvent({
      id: "macbid-reauthentication",
      start: data.refreshTokenExpiration,
      end: data.refreshTokenExpiration,
      summary: "Mac.Bid Calendar Reauthentication Required",
      description: `Your Mac.Bid session for this calendar expires around this time. Sign in to renew:\n${renewUrl}`,
      url: renewUrl,
    });

    data.watchlist.forEach(({ favorite, closes }) => {
      calendar.createEvent({
        id: `macbid-watchlist-${favorite.auction_lot_id}`,
        start: closes,
        end: closes,
        summary: favorite.title,
        description: `This item is ending on Mac.bid at this time. Make sure to set a notification. The item is here: https://www.mac.bid/auction/${favorite.auction_number}/lot/${favorite.lot_number}`,
      });
    });

    for (const event of buildPickupEvents(
      data.activeItems,
      data.locations,
      data.buildings
    )) {
      const pickupKey = createHash("sha256")
        .update(`${event.summary}|${event.location}|${event.start.toISOString()}`)
        .digest("hex")
        .slice(0, 16);

      calendar.createEvent({
        id: `macbid-pickup-${pickupKey}`,
        summary: event.summary,
        start: event.start,
        end: event.end,
        location: event.location,
        description: event.description,
      });
    }

    return { signedIn: true, body: calendar.toString() };
  };

  // Each build is a session check, four Mac.Bid requests and one per watchlist
  // lot (a few at a time). Share one build
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
    // The sign-in placeholder is kept for a shorter time: long enough that
    // polling cannot hammer a login (each one can text a code), short enough
    // that a fresh sign-in shows up quickly. Signing in clears it at once.
    const ttlSeconds = result.signedIn
      ? cacheSeconds
      : Math.min(cacheSeconds, 60);
    if (ttlSeconds > 0) {
      cachedFeed = {
        body: result.body,
        expires: Date.now() + ttlSeconds * 1000,
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

  // Behind nginx: TLS is terminated at the proxy, which is set up by naming its
  // public URL (ICAL_PUBLIC_URL) and sends X-Forwarded-Proto: https. Both are
  // required, so a request that reaches the HTTP port directly (no header) never
  // gets the sign-in form in cleartext, and the header alone is not trusted.
  const serveLoginOnHttpPort = (req: http.IncomingMessage): boolean =>
    publicUrlConfigured && proxiedHttps(req);

  const redirectLoginToHttps = (
    req: http.IncomingMessage,
    res: http.ServerResponse
  ) => {
    res.writeHead(307, { Location: loginRedirectUrl(req.url) });
    res.end();
  };

  const refuseLoginWithoutHttps = (res: http.ServerResponse) => {
    res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(
      "Sign-in is turned off: it needs HTTPS, and this server has no TLS certificate.\n" +
        "Put it behind a TLS-terminating proxy and set ICAL_PUBLIC_URL, " +
        "or set ICAL_TLS_CERT and ICAL_TLS_KEY.\n"
    );
  };

  const handleLoginRoute = (
    route: "login" | "login-send-code",
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): void => {
    const limiter = route === "login" ? codeLimiter : sendCodeLimiter;
    if (req.method === "POST" && limiter.limited()) {
      console.warn("Too many sign-in attempts; refusing for now");
      res.writeHead(429, {
        "Content-Type": "text/plain; charset=utf-8",
        "Retry-After": String(limiter.retryAfterSeconds()),
      });
      res.end(
        `Too many sign-in attempts. Try again in ${Math.ceil(limiter.retryAfterSeconds() / 60)} minute(s).\n`
      );
      return;
    }
    if (req.method === "POST") {
      limiter.record();
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
  if (!signInAvailable) {
    console.error(
      "No TLS certificate and no openssl to make one, and ICAL_PUBLIC_URL is not set: sign-in is turned off. " +
        "Sign in through a TLS-terminating proxy (set ICAL_PUBLIC_URL), or set ICAL_TLS_CERT and ICAL_TLS_KEY."
    );
  }
  const httpPort = portFromEnv("ICAL_PORT", 3000);
  const tlsPort = portFromEnv("ICAL_TLS_PORT", 3443);
  const bind = process.env.ICAL_URL || "127.0.0.1";

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
        } else if (publicUrlConfigured && !proxiedHttps(req)) {
          // Redirecting would send a proxy that omits the header round in circles
          res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
          res.end(
            "Sign-in needs HTTPS. If this is a reverse proxy, make it send " +
              "X-Forwarded-Proto: https; otherwise use the HTTPS sign-in port.\n"
          );
        } else if (tls) {
          redirectLoginToHttps(req, res);
        } else {
          refuseLoginWithoutHttps(res);
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
  }

  // Runs after the servers are listening, so a slow Mac.Bid never keeps the
  // port closed (health checks and calendar polls get an answer meanwhile)
  const authenticateOnStartup = async (): Promise<void> => {
    console.log("Authenticating on startup...");
    if (!hasActiveSession(persistedAuth) && !envCredentials()) {
      console.log(
        "No active Mac.Bid session. Sign in at:",
        redactSecret(signInUrl())
      );
    } else {
      try {
        await withAuthLock(() => authenticateAndPersist());
        console.log("✓ Authentication successful on startup");
      } catch (error) {
        console.error(
          "✗ Authentication failed on startup:",
          errorMessage(error)
        );
        console.error("Sign in at:", redactSecret(signInUrl()));
      }
    }
  };

  void authenticateOnStartup();

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
