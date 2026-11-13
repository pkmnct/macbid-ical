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
  MAX_RETRY_WAIT_MS,
  MIN_LOTS_FOR_API_CHANGE,
  mapWithConcurrency,
  resolveWatchlistCloses,
  settleAll,
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

const noSleep = async () => undefined;
const quiet = { warn: () => undefined, sleep: noSleep };
const ok = (lotId: number) => lotStatus(lotId, "2026-11-17T00:35:59.000Z");
const unavailable = (retryAfterMs?: number) =>
  new MacBidUnavailableError("Mac.Bid returned HTTP 429", { retryAfterMs });

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

  it("throws when no lot of a longer watchlist can be read: the endpoint has likely moved", async () => {
    assert.equal(MIN_LOTS_FOR_API_CHANGE, 3);
    for (const failure of [
      notFound,
      () => new Error("Mac.Bid lot response has no usable end_time; the API may have changed"),
    ]) {
      await assert.rejects(
        resolveWatchlistCloses(
          [favorite(1), favorite(2), favorite(3)],
          async (lotId) => {
            throw failure(lotId);
          },
          quiet
        ),
        /None of the 3 watchlist lots could be looked up/
      );
    }
  });

  it("keeps the feed going when a short watchlist's only lots were removed", async () => {
    for (const lots of [[favorite(1)], [favorite(1), favorite(2)]]) {
      const warnings: string[] = [];
      const closes = await resolveWatchlistCloses(
        lots,
        async (lotId) => {
          throw notFound(lotId);
        },
        { ...quiet, warn: (message) => warnings.push(message) }
      );
      assert.deepEqual(closes, []);
      assert.equal(warnings.length, lots.length);
    }
  });

  it("is an empty list for an empty watchlist, without asking for any lot", async () => {
    const closes = await resolveWatchlistCloses(
      [],
      async () => assert.fail("no lot should be fetched"),
      quiet
    );
    assert.deepEqual(closes, []);
  });

  it("skips one odd lot instead of failing the feed, never using expected_close_date", async () => {
    for (const error of [
      new Error("Mac.Bid lot response has no usable end_time; the API may have changed"),
      new Error("Not a Mac.Bid lot id: 0"),
    ]) {
      const warnings: string[] = [];
      const closes = await resolveWatchlistCloses(
        [MAGNET_MAKER, favorite(2)],
        async (lotId) => {
          if (lotId === MAGNET_MAKER.auction_lot_id) {
            throw error;
          }
          return ok(lotId);
        },
        { ...quiet, warn: (message) => warnings.push(message) }
      );
      assert.deepEqual(
        closes.map((close) => close.favorite.auction_lot_id),
        [2]
      );
      assert.equal(warnings.length, 1);
      assert.ok(warnings[0]!.includes(error.message));
    }
  });

  it("passes a sign-in failure through unchanged", async () => {
    const error = new MacBidAuthError("Mac.Bid returned HTTP 401", { status: 401 });
    await assert.rejects(
      resolveWatchlistCloses(
        [favorite(1), favorite(2)],
        async (lotId) => {
          if (lotId === 2) {
            throw error;
          }
          return ok(lotId);
        },
        quiet
      ),
      (thrown) => thrown === error
    );
  });

  it("retries a rate-limited lot once, waiting as asked up to a cap", async () => {
    for (const [retryAfterMs, waited] of [
      [2_000, 2_000],
      [60_000, MAX_RETRY_WAIT_MS],
      [undefined, 1_000],
    ] as const) {
      const waits: number[] = [];
      let calls = 0;
      const [close] = await resolveWatchlistCloses(
        [MAGNET_MAKER],
        async (lotId) => {
          if (calls++ === 0) {
            throw unavailable(retryAfterMs);
          }
          return ok(lotId);
        },
        { ...quiet, sleep: async (ms) => void waits.push(ms) }
      );
      assert.equal(calls, 2);
      assert.deepEqual(waits, [waited]);
      assert.equal(close!.closes.toISOString(), "2026-11-17T00:35:59.000Z");
    }
  });

  it("uses the last known close time when a lot stays unavailable", async () => {
    const lastKnown = new Map<number, Date>();
    await resolveWatchlistCloses([MAGNET_MAKER, favorite(2)], async (lotId) => ok(lotId), {
      ...quiet,
      lastKnown,
    });
    assert.equal(lastKnown.get(67826120)?.toISOString(), "2026-11-17T00:35:59.000Z");

    const warnings: string[] = [];
    const closes = await resolveWatchlistCloses(
      [MAGNET_MAKER, favorite(2)],
      async (lotId) => {
        if (lotId === MAGNET_MAKER.auction_lot_id) {
          throw unavailable();
        }
        return lotStatus(lotId, "2026-11-17T01:00:00.000Z");
      },
      { ...quiet, lastKnown, warn: (message) => warnings.push(message) }
    );
    assert.deepEqual(
      closes.map((close) => [close.favorite.auction_lot_id, close.closes.toISOString()]),
      [
        [67826120, "2026-11-17T00:35:59.000Z"],
        [2, "2026-11-17T01:00:00.000Z"],
      ]
    );
    assert.match(warnings[0]!, /last known close time/);
  });

  it("fails the build when a lot stays unavailable and was never read", async () => {
    const error = unavailable();
    await assert.rejects(
      resolveWatchlistCloses(
        [favorite(1), favorite(2)],
        async (lotId) => {
          if (lotId === 2) {
            throw error;
          }
          return ok(lotId);
        },
        { ...quiet, lastKnown: new Map() }
      ),
      (thrown) => thrown === error
    );
  });

  it("stops sending requests once a lot is still rate-limited after its retry", async () => {
    const favorites = Array.from({ length: 12 }, (_, index) => favorite(index + 1));
    const lastKnown = new Map(
      favorites.map((item) => [item.auction_lot_id, new Date("2026-11-17T00:00:00Z")])
    );
    let calls = 0;
    let waits = 0;
    const warnings: string[] = [];
    const closes = await resolveWatchlistCloses(
      favorites,
      async () => {
        calls++;
        throw unavailable(60_000);
      },
      {
        lastKnown,
        warn: (message) => warnings.push(message),
        sleep: async () => {
          waits++;
          await new Promise((resolve) => setTimeout(resolve, 1));
        },
      }
    );
    assert.equal(closes.length, 12);
    // The first round of 4 tries and waits; at most those 4 retry
    assert.ok(calls <= 8, `${calls} requests`);
    assert.ok(waits <= 4, `${waits} waits`);
    // One line for the rate limit, not one per lot
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /rate-limiting/);
  });

  it("does not treat a rate limit as an API change", async () => {
    const favorites = [favorite(1), favorite(2), favorite(3)];
    const lastKnown = new Map(
      favorites.map((item) => [item.auction_lot_id, new Date("2026-11-17T00:00:00Z")])
    );
    const closes = await resolveWatchlistCloses(
      favorites,
      async () => {
        throw unavailable();
      },
      { ...quiet, lastKnown }
    );
    assert.equal(closes.length, 3);
  });

  it("keeps a lot's last known time through a passing bad answer", async () => {
    const lastKnown = new Map([[67826120, new Date("2026-11-17T00:35:59.000Z")]]);
    const warnings: string[] = [];
    const [close] = await resolveWatchlistCloses(
      [MAGNET_MAKER],
      async () => {
        throw new Error("Mac.Bid returned a response that is not JSON");
      },
      { ...quiet, lastKnown, warn: (message) => warnings.push(message) }
    );
    assert.equal(close!.closes.toISOString(), "2026-11-17T00:35:59.000Z");
    assert.match(warnings[0]!, /last known close time.*not JSON/);
  });

  it("drops a removed lot even with a last known time", async () => {
    const lastKnown = new Map([
      [1, new Date("2026-11-17T00:00:00Z")],
      [2, new Date("2026-11-17T00:00:00Z")],
    ]);
    const closes = await resolveWatchlistCloses(
      [favorite(1), favorite(2)],
      async (lotId) => {
        if (lotId === 1) {
          throw notFound(lotId);
        }
        return ok(lotId);
      },
      { ...quiet, lastKnown }
    );
    assert.deepEqual(
      closes.map((close) => close.favorite.auction_lot_id),
      [2]
    );
    assert.ok(!lastKnown.has(1));
  });

  it("still fails loudly when every lot answers badly, last known times or not", async () => {
    const favorites = [favorite(1), favorite(2), favorite(3)];
    const lastKnown = new Map(
      favorites.map((item) => [item.auction_lot_id, new Date("2026-11-17T00:00:00Z")])
    );
    await assert.rejects(
      resolveWatchlistCloses(
        favorites,
        async () => {
          throw new Error("Mac.Bid lot response has no usable end_time; the API may have changed");
        },
        { ...quiet, lastKnown }
      ),
      /None of the 3 watchlist lots/
    );
  });

  it("passes lookups through quietly once another request has signed the client out", async () => {
    const warnings: string[] = [];
    let signedIn = true;
    const error = new Error("Not authenticated");
    await assert.rejects(
      resolveWatchlistCloses(
        [favorite(1), favorite(2), favorite(3)],
        async () => {
          // get_active got a 401 meanwhile and the library dropped the session
          signedIn = false;
          throw error;
        },
        { ...quiet, signedIn: () => signedIn, warn: (message) => warnings.push(message) }
      ),
      (thrown) => thrown === error
    );
    assert.deepEqual(warnings, []);
  });

  it("forgets lots that are no longer watched", async () => {
    const lastKnown = new Map([[99, new Date("2026-11-01T00:00:00Z")]]);
    await resolveWatchlistCloses([favorite(1)], async (lotId) => ok(lotId), {
      ...quiet,
      lastKnown,
    });
    assert.deepEqual([...lastKnown.keys()], [1]);
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

  it("waits for the calls already running before it rejects", async () => {
    let running = 0;
    await assert.rejects(
      mapWithConcurrency([1, 2, 3, 4], 4, async (item) => {
        running++;
        try {
          if (item === 1) {
            throw new Error("boom");
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
          return item;
        } finally {
          running--;
        }
      }),
      /boom/
    );
    assert.equal(running, 0);
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

describe("settleAll", () => {
  it("returns every value in order", async () => {
    assert.deepEqual(await settleAll([Promise.resolve(1), Promise.resolve("a")]), [1, "a"]);
  });

  it("lets everything finish before it rejects", async () => {
    let finished = false;
    await assert.rejects(
      settleAll([
        Promise.reject(new Error("first")),
        (async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          finished = true;
        })(),
      ]),
      /first/
    );
    assert.ok(finished);
  });

  it("throws a sign-in failure ahead of other errors", async () => {
    const auth = new MacBidAuthError("Mac.Bid returned HTTP 401", { status: 401 });
    await assert.rejects(
      settleAll([Promise.reject(new Error("other")), Promise.reject(auth)]),
      (thrown) => thrown === auth
    );
  });
});
