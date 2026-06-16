import dotenv from "dotenv";
import MacBid, { type AuthInfo, type SerializableAuthState } from "macbid-ts-api";
import ical from "ical-generator";
import http from "node:http";
import { join } from "node:path";
import {
  clearAuthStateFile,
  loadAuthStateFile,
  mergePersistedAuthState,
  reconcileValidationCode,
  saveAuthStateFile,
  toAuthInfo,
  type PersistedAuthState,
} from "./authStateFile.js";

dotenv.config();

function envValidationCode(): string | undefined {
  const code = process.env.MACBID_VALIDATION_CODE?.trim();
  return code || undefined;
}

(async () => {
  if (!process.env.ICAL_UNIQUE_URL) {
    throw new Error("You must set ICAL_UNIQUE_URL");
  }

  const authStatePath = join(process.cwd(), ".macbid-tokens.json");
  const api = new MacBid();

  const loadPersistedAuth = async (): Promise<PersistedAuthState | null> => {
    const envCode = envValidationCode();
    const loaded = await loadAuthStateFile(authStatePath);
    const { state, cleared } = reconcileValidationCode(envCode, loaded);

    if (cleared) {
      console.log(
        "Validation code changed or removed; clearing saved auth state."
      );
      await clearAuthStateFile(authStatePath);
    }

    return state;
  };

  let persistedAuth = await loadPersistedAuth();

  const persistFromApi = async (
    apiState: SerializableAuthState
  ): Promise<void> => {
    const envCode = envValidationCode();
    persistedAuth = mergePersistedAuthState(apiState, envCode, persistedAuth);
    await saveAuthStateFile(authStatePath, persistedAuth);
  };

  const buildAuthParams = (): Partial<AuthInfo> => {
    const params: Partial<AuthInfo> = {
      email: process.env.MACBID_EMAIL,
      password: process.env.MACBID_PASSWORD,
      ...toAuthInfo(persistedAuth),
    };

    if (!params.token && !params.refresh_token) {
      params.validation_code = envValidationCode();
    }

    return params;
  };

  const authenticateAndPersist = async (): Promise<void> => {
    try {
      await api.authenticate(buildAuthParams());
    } finally {
      await persistFromApi(api.getAuthState());
    }
  };

  console.log("Authenticating on startup...");
  try {
    await authenticateAndPersist();
    console.log("✓ Authentication successful on startup");
  } catch (error) {
    console.error("✗ Authentication failed on startup:", error);
    console.error("Server will still start, but requests may fail until authentication is fixed.");
  }

  const port = process.env.ICAL_PORT ? parseInt(process.env.ICAL_PORT) : 3000;
  const url = process.env.ICAL_URL || "127.0.0.1";

  http
    .createServer((req, res) => {
      if (req.url === "/" + process.env.ICAL_UNIQUE_URL) {
        console.log(`Valid incoming request, getting watchlist...`);
        (async () => {
          persistedAuth = await loadPersistedAuth();
          await authenticateAndPersist();
          const favorites = await api.get_watchlist();
          await persistFromApi(api.getAuthState());
          const refresh_token_expiration = await api.get_refresh_token_expiration();

          const calendar = ical({
            name: `Mac.Bid Watchlist`,
            timezone: "America/New_York",
          });

          calendar.createEvent({
            start: refresh_token_expiration,
            end: refresh_token_expiration,
            summary: "Mac.Bid Calendar Reauthentication Required",
            description: "The refresh token for the Mac.Bid API will expire at this time. You will need to re-authenticate for your calendar to continue receiving updates.",
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

          res.writeHead(200, {
            "Content-Type": "text/calendar; charset=utf-8",
          });
          res.end(calendar.toString());
        })().catch((error) => {
          console.error("Failed to serve calendar:", error);
          if (!res.headersSent) {
            res.writeHead(500);
            res.end();
          }
        });
      } else {
        console.log("Invalid incoming request", req.url, req.headers);
        res.destroy();
      }
    })
    .listen(port, url, () => {
      console.log(
        `iCal Feed Served at http://${url}:${port}/${process.env.ICAL_UNIQUE_URL}`
      );
    });
})();
