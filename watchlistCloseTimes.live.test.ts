/**
 * Live check against Mac.Bid with the saved session (data/tokens.json, or
 * $ICAL_DATA_DIR/tokens.json). Opt in with MACBID_LIVE_TEST=1:
 *
 *   MACBID_LIVE_TEST=1 npm test
 *
 * Skipped without that variable, so CI and plain `npm test` never touch the
 * network. Also skipped unless the saved access token has at least
 * FRESH_MINUTES left: the library refreshes within 5 minutes of expiry, and
 * refresh tokens rotate, so a refresh here could spend the token a running
 * server is about to use. With a fresh access token nothing is refreshed and
 * the file is not written. (If Mac.Bid rejects the token anyway and the library
 * refreshes, the new tokens are saved back; a server refreshing at that same
 * moment could still lose. Stop the server to be sure.) Tokens are never
 * printed.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import MacBid, { MacBidNotFoundError } from "macbid-ts-api";
import {
  hasActiveSession,
  loadAuthStateFile,
  mergePersistedAuthState,
  saveAuthStateFile,
  shouldPersistAuthState,
  toAuthInfo,
} from "./authStateFile.js";
import { authStatePath } from "./dataDir.js";
import {
  LOT_LOOKUP_CONCURRENCY,
  mapWithConcurrency,
} from "./watchlistCloseTimes.js";

const path = authStatePath();
const saved = await loadAuthStateFile(path);
const FRESH_MINUTES = 15;
const accessTokenFresh =
  !!saved?.token &&
  !!saved.token_expiration &&
  Date.parse(saved.token_expiration) - Date.now() >= FRESH_MINUTES * 60_000;
const skip =
  process.env.MACBID_LIVE_TEST !== "1"
    ? "set MACBID_LIVE_TEST=1 to run against Mac.Bid"
    : !hasActiveSession(saved)
      ? `no saved Mac.Bid session at ${path}`
      : !accessTokenFresh
        ? `the saved access token has under ${FRESH_MINUTES} minutes left; run again after the server's next refresh`
        : false;

const minutes = (ms: number) => `${ms >= 0 ? "+" : ""}${(ms / 60_000).toFixed(1)} min`;

describe("live: watchlist close times from get_lot", { skip }, () => {
  it("reads a parseable end_time for every watchlist lot", async () => {
    const api = new MacBid();
    try {
      await api.authenticate(toAuthInfo(saved));
      const favorites = await api.get_watchlist();
      console.log(`Watchlist has ${favorites.length} item(s)`);

      // get_lot directly, so any failure fails the test rather than being
      // skipped as the feed would; a removed lot (404) is only reported
      const looked = await mapWithConcurrency(
        favorites,
        LOT_LOOKUP_CONCURRENCY,
        async (favorite) => {
          try {
            return { favorite, lot: await api.get_lot(favorite.auction_lot_id) };
          } catch (error) {
            if (error instanceof MacBidNotFoundError) {
              console.log(`${favorite.lot_number} (${favorite.auction_lot_id}): not found`);
              return null;
            }
            throw error;
          }
        }
      );

      for (const item of looked) {
        if (!item) {
          continue;
        }
        const { favorite, lot } = item;
        const end = new Date(lot.end_time);
        assert.ok(
          !Number.isNaN(end.getTime()),
          `lot ${favorite.auction_lot_id} end_time ${JSON.stringify(lot.end_time)}`
        );
        const expected = new Date(favorite.expected_close_date);
        const gap = Number.isNaN(expected.getTime())
          ? "expected_close_date unreadable"
          : `expected_close_date is end_time ${minutes(expected.getTime() - end.getTime())}`;
        console.log(
          `${favorite.lot_number} (${favorite.auction_lot_id}): end_time ${end.toISOString()}, ` +
            `${end.toLocaleString("en-US", { timeZone: "America/New_York" })} New York; ${gap}`
        );
      }
      assert.ok(favorites.length === 0 || looked.some((item) => item !== null));
    } finally {
      // Only if the library refreshed after all: the saved refresh token is
      // then spent, and the new one must not be lost
      const state = api.getAuthState();
      if (
        state.refresh_token !== saved?.refresh_token &&
        shouldPersistAuthState(state, saved)
      ) {
        await saveAuthStateFile(
          path,
          mergePersistedAuthState(state, undefined, saved)
        );
      }
    }
  });
});
