/**
 * Live check against Mac.Bid with the saved session (data/tokens.json, or
 * $ICAL_DATA_DIR/tokens.json). Opt in with MACBID_LIVE_TEST=1:
 *
 *   MACBID_LIVE_TEST=1 npm test
 *
 * Skipped without that variable or without a saved, unexpired session, so CI
 * and plain `npm test` never touch the network. Refreshed tokens are saved back,
 * as the server does, so running it cannot sign the feed out. Tokens are never
 * printed.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import MacBid from "macbid-ts-api";
import {
  hasActiveSession,
  loadAuthStateFile,
  mergePersistedAuthState,
  saveAuthStateFile,
  shouldPersistAuthState,
  toAuthInfo,
} from "./authStateFile.js";
import { authStatePath } from "./dataDir.js";
import { resolveWatchlistCloses } from "./watchlistCloseTimes.js";

const path = authStatePath();
const saved = await loadAuthStateFile(path);
const skip =
  process.env.MACBID_LIVE_TEST !== "1"
    ? "set MACBID_LIVE_TEST=1 to run against Mac.Bid"
    : !hasActiveSession(saved)
      ? `no saved Mac.Bid session at ${path}`
      : false;

const minutes = (ms: number) => `${ms >= 0 ? "+" : ""}${(ms / 60_000).toFixed(1)} min`;

describe("live: watchlist close times from get_lot", { skip }, () => {
  it("reads a parseable end_time for every watchlist lot", async () => {
    const api = new MacBid();
    try {
      await api.authenticate(toAuthInfo(saved));
      const favorites = await api.get_watchlist();
      console.log(`Watchlist has ${favorites.length} item(s)`);

      const closes = await resolveWatchlistCloses(favorites, async (lotId) => {
        const lot = await api.get_lot(lotId);
        assert.ok(
          !Number.isNaN(Date.parse(lot.end_time)),
          `lot ${lotId} end_time ${JSON.stringify(lot.end_time)}`
        );
        return lot;
      });

      for (const { favorite, closes: end } of closes) {
        const expected = new Date(favorite.expected_close_date);
        const gap = Number.isNaN(expected.getTime())
          ? "expected_close_date unreadable"
          : `expected_close_date is end_time ${minutes(expected.getTime() - end.getTime())}`;
        console.log(
          `${favorite.lot_number} (${favorite.auction_lot_id}): end_time ${end.toISOString()}, ` +
            `${end.toLocaleString("en-US", { timeZone: "America/New_York" })} New York; ${gap}`
        );
      }
      assert.ok(favorites.length === 0 || closes.length > 0);
    } finally {
      // Keep any refreshed tokens, or the saved refresh token may be spent
      const state = api.getAuthState();
      if (shouldPersistAuthState(state, saved)) {
        await saveAuthStateFile(
          path,
          mergePersistedAuthState(state, undefined, saved)
        );
      }
    }
  });
});
