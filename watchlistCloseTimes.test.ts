import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MacBidAuthError,
  MacBidNotFoundError,
  MacBidUnavailableError,
  type LotStatus,
  type WatchlistFull,
} from "macbid-ts-api";
import {
  LOT_LOOKUP_CONCURRENCY,
  mapWithConcurrency,
  resolveWatchlistCloses,
} from "./watchlistCloseTimes.js";

// Lot 2230R (Magnet Maker), as Mac.Bid answered on 13 Nov 2026. The site shows
// it closing at 7:35:59 PM EST on 16 Nov, which is 2026-11-17T00:35:59Z.
const MAGNET_MAKER = {
  auction_lot_id: 67826120,
  lot_number: "2230R",
  auction_number: "101336",
  title: "Magnet Maker",
  // From /auctions/customer/{id}/active-auctions: an hour ahead of Eastern
  expected_close_date: "2026-11-16T20:35:59.000Z",
} as unknown as WatchlistFull;

const lotStatus = (lotId: number, end_time: string) =>
  ({ lot_id: String(lotId), end_time }) as unknown as LotStatus;

const favorite = (auction_lot_id: number) =>
  ({
    auction_lot_id,
    title: `Lot ${auction_lot_id}`,
    expected_close_date: "2026-11-16T20:00:00.000Z",
  }) as unknown as WatchlistFull;

const notFound = (lotId: number) =>
  new MacBidNotFoundError(`Mac.Bid returned HTTP 404 for /lot/${lotId}`, {
    path: `/lot/${lotId}`,
  });

const quiet = { warn: () => undefined };

describe("resolveWatchlistCloses", () => {
  it("times lot 2230R from get_lot's end_time, not expected_close_date", async () => {
    const asked: number[] = [];
    const [close, ...rest] = await resolveWatchlistCloses(
      [MAGNET_MAKER],
      async (lotId) => {
        asked.push(lotId);
        return lotStatus(lotId, "2026-11-17T00:35:59.000Z");
      },
      quiet
    );
    assert.deepEqual(asked, [67826120]);
    assert.equal(rest.length, 0);
    assert.equal(close!.favorite, MAGNET_MAKER);
    assert.equal(close!.closes.toISOString(), "2026-11-17T00:35:59.000Z");
    // 7:35:59 PM in New York, where the old code said 8:35:59 PM
    assert.equal(
      close!.closes.toLocaleTimeString("en-US", { timeZone: "America/New_York" }),
      "7:35:59 PM"
    );
  });

  it("follows end_time when a late bid extends the lot", async () => {
    const [close] = await resolveWatchlistCloses(
      [MAGNET_MAKER],
      async (lotId) => lotStatus(lotId, "2026-11-17T00:37:29.000Z"),
      quiet
    );
    assert.equal(close!.closes.toISOString(), "2026-11-17T00:37:29.000Z");
  });

  it("keeps watchlist order", async () => {
    const closes = await resolveWatchlistCloses(
      [favorite(3), favorite(1), favorite(2)],
      async (lotId) => {
        // Answer out of order
        await new Promise((resolve) => setTimeout(resolve, lotId * 5));
        return lotStatus(lotId, `2026-11-17T0${lotId}:00:00.000Z`);
      },
      quiet
    );
    assert.deepEqual(
      closes.map((close) => close.favorite.auction_lot_id),
      [3, 1, 2]
    );
  });

  it("skips a lot Mac.Bid no longer has, with a warning", async () => {
    const warnings: string[] = [];
    const closes = await resolveWatchlistCloses(
      [favorite(1), favorite(2), favorite(3)],
      async (lotId) => {
        if (lotId === 2) {
          throw notFound(lotId);
        }
        return lotStatus(lotId, "2026-11-17T00:35:59.000Z");
      },
      { warn: (message) => warnings.push(message) }
    );
    assert.deepEqual(
      closes.map((close) => close.favorite.auction_lot_id),
      [1, 3]
    );
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /watchlist item 2\b/);
  });

  it("throws when every lot is missing: the endpoint has likely moved", async () => {
    await assert.rejects(
      resolveWatchlistCloses(
        [favorite(1), favorite(2)],
        async (lotId) => {
          throw notFound(lotId);
        },
        quiet
      ),
      /None of the 2 watchlist lots could be looked up/
    );
  });

  it("is an empty list for an empty watchlist, without asking for any lot", async () => {
    const closes = await resolveWatchlistCloses(
      [],
      async () => assert.fail("no lot should be fetched"),
      quiet
    );
    assert.deepEqual(closes, []);
  });

  it("passes sign-in, outage and other errors through unchanged", async () => {
    for (const error of [
      new MacBidAuthError("Mac.Bid returned HTTP 401", { status: 401 }),
      new MacBidUnavailableError("Mac.Bid returned HTTP 503"),
      new Error("Mac.Bid lot response has no usable end_time; the API may have changed"),
    ]) {
      await assert.rejects(
        resolveWatchlistCloses(
          [favorite(1), favorite(2)],
          async (lotId) => {
            if (lotId === 2) {
              throw error;
            }
            return lotStatus(lotId, "2026-11-17T00:35:59.000Z");
          },
          quiet
        ),
        (thrown) => thrown === error
      );
    }
  });

  it("does not fall back to expected_close_date when end_time is unreadable", async () => {
    await assert.rejects(
      resolveWatchlistCloses(
        [MAGNET_MAKER],
        async (lotId) => lotStatus(lotId, "soon"),
        quiet
      ),
      /unreadable end_time/
    );
  });

  it("looks up at most four lots at a time", async () => {
    assert.equal(LOT_LOOKUP_CONCURRENCY, 4);
    let running = 0;
    let peak = 0;
    const favorites = Array.from({ length: 11 }, (_, index) => favorite(index + 1));
    const closes = await resolveWatchlistCloses(
      favorites,
      async (lotId) => {
        running++;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 5));
        running--;
        return lotStatus(lotId, "2026-11-17T00:35:59.000Z");
      },
      quiet
    );
    assert.equal(closes.length, 11);
    assert.equal(peak, 4);
  });
});

describe("mapWithConcurrency", () => {
  it("never runs more than the limit at once, and runs everything", async () => {
    for (const limit of [1, 2, 3, 10]) {
      let running = 0;
      let peak = 0;
      const results = await mapWithConcurrency(
        [1, 2, 3, 4, 5, 6, 7],
        limit,
        async (item) => {
          running++;
          peak = Math.max(peak, running);
          await new Promise((resolve) => setTimeout(resolve, 2));
          running--;
          return item * 10;
        }
      );
      assert.deepEqual(results, [10, 20, 30, 40, 50, 60, 70]);
      assert.equal(peak, Math.min(limit, 7), `limit ${limit}`);
    }
  });

  it("starts nothing new after a failure", async () => {
    const started: number[] = [];
    await assert.rejects(
      mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (item) => {
        started.push(item);
        await new Promise((resolve) => setTimeout(resolve, 2));
        if (item === 1) {
          throw new Error("boom");
        }
        return item;
      }),
      /boom/
    );
    // 1 and 2 ran together; 2's worker may have picked up 3 before 1 failed
    assert.ok(started.length <= 3, String(started));
  });
});
