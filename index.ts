import dotenv from "dotenv";
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

dotenv.config();

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

  const authStateFile = authStatePath();
  const legacyCredentialsFile = legacyCredentialsPath();
  const tlsPath = tlsDir();
  const api = new MacBid();
  const pendingCredentials = new PendingCredentials();

  await ensureDataDir();
  await unlink(legacyCredentialsFile).catch(() => undefined);

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
      await persistFromApi(api.getAuthState(), previous);
      throw error;
    }
  };

  const sendHtml = (res: http.ServerResponse, status: number, html: string) => {
    res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
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

      console.error("Failed to send verification code:", error);
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
      console.error("Login failed:", error);
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

  const handleFeed = (res: http.ServerResponse) => {
    console.log("Valid incoming request, building calendar...");
    const renewUrl = loginPageUrl();

    const serveAuthRequiredFeed = (reason: unknown): void => {
      console.error("Serving sign-in required calendar:", reason);
      const calendar = createMacbidCalendar();
      addAuthRequiredEvent(calendar, renewUrl);
      sendCalendarResponse(res, calendar);
    };

    (async () => {
      persistedAuth = await loadPersistedAuth();

      if (
        !hasActiveSession(persistedAuth) &&
        !envCredentials() &&
        !pendingCredentials.get()
      ) {
        serveAuthRequiredFeed("No active session and no credentials configured");
        return;
      }

      try {
        await authenticateAndPersist();
      } catch (error) {
        serveAuthRequiredFeed(error);
        return;
      }

      const [favorites, activeItems, locations, buildings] = await Promise.all([
        api.get_watchlist(),
        api.get_active(),
        api.get_locations(),
        api.get_buildings(),
      ]);
      await persistFromApi(api.getAuthState());
      const refresh_token_expiration = await api.get_refresh_token_expiration();

      const calendar = createMacbidCalendar();

      calendar.createEvent({
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
          start: eventDate,
          end: eventDate,
          summary: favorite.title,
          description: `This item is ending on Mac.bid at this time. Make sure to set a notification. The item is here: https://www.mac.bid/auction/${favorite.auction_number}/lot/${favorite.lot_number}`,
        });
      });

      for (const event of buildPickupEvents(activeItems, locations, buildings)) {
        calendar.createEvent({
          summary: event.summary,
          start: event.start,
          end: event.end,
          timezone: event.timezone,
          location: event.location,
          description: event.description,
        });
      }

      sendCalendarResponse(res, calendar);
    })().catch((error) => {
      if (!res.headersSent) {
        serveAuthRequiredFeed(error);
      }
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
    console.log("No active Mac.Bid session. Sign in at:", loginPageUrl());
  } else {
    try {
      await authenticateAndPersist();
      console.log("✓ Authentication successful on startup");
    } catch (error) {
      console.error("✗ Authentication failed on startup:", error);
      console.error("Sign in at:", loginPageUrl());
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

  http
    .createServer((req, res) => {
      const route = parseAppPath(req.url, feedSecret);

      if (route === "feed") {
        handleFeed(res);
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
      console.log(`iCal feed:  http://${bind === "0.0.0.0" ? "127.0.0.1" : bind}:${httpPort}/${feedSecret}`);
    });

  https
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
      console.log(`Sign in:    https://${host}:${tlsPort}/${feedSecret}/login`);
    });
})();
