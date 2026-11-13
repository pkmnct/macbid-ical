import {
  MacBidNotFoundError,
  type LotStatus,
  type WatchlistFull,
} from "macbid-ts-api";

/**
 * Watchlist close times come from each lot's `end_time` (`get_lot`), a real UTC
 * instant that also moves later when a late bid extends the lot. The
 * watchlist's own `expected_close_date` is not used: its digits have been an
 * hour ahead of the Eastern time the site shows (lot 2230R, shown closing at
 * 7:35:59 PM EST, came back as "2026-11-16T20:35:59Z"), and it stays at the
 * scheduled close after an extension.
 */

/** How many `get_lot` requests run at once: a burst can get a 429. */
export const LOT_LOOKUP_CONCURRENCY = 4;

export interface WatchlistClose {
  favorite: WatchlistFull;
  closes: Date;
}

/**
 * `fn` over `items`, at most `limit` at a time, results in input order. After
 * the first failure no new item is started, and that failure is thrown.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (!failed && next < items.length) {
      const index = next++;
      try {
        results[index] = await fn(items[index]!, index);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  const workers = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workers }, worker));
  return results;
}

/**
 * Each watchlist item with its lot's real close time.
 *
 * A lot that Mac.Bid no longer has (`MacBidNotFoundError`) is skipped with a
 * warning. Any other error is thrown as it is, so sign-in and outage errors
 * keep their usual handling. If no lot of a non-empty watchlist could be
 * looked up, the lot endpoint has likely changed: that is thrown too, rather
 * than serving a feed that silently lost every watchlist event.
 */
export async function resolveWatchlistCloses(
  favorites: readonly WatchlistFull[],
  getLot: (lotId: number) => Promise<LotStatus>,
  {
    concurrency = LOT_LOOKUP_CONCURRENCY,
    warn = console.warn,
  }: { concurrency?: number; warn?: (message: string) => void } = {}
): Promise<WatchlistClose[]> {
  const looked = await mapWithConcurrency(
    favorites,
    concurrency,
    async (favorite): Promise<WatchlistClose | null> => {
      let lot: LotStatus;
      try {
        lot = await getLot(favorite.auction_lot_id);
      } catch (error) {
        if (error instanceof MacBidNotFoundError) {
          warn(
            `Skipping watchlist item ${favorite.auction_lot_id}: Mac.Bid has no such lot`
          );
          return null;
        }
        throw error;
      }
      const closes = new Date(lot.end_time);
      if (Number.isNaN(closes.getTime())) {
        // get_lot checks this already; an unreadable time means the API moved
        throw new Error(
          `Mac.Bid lot ${favorite.auction_lot_id} has an unreadable end_time; the API may have changed`
        );
      }
      return { favorite, closes };
    }
  );

  const closes = looked.filter((item): item is WatchlistClose => item !== null);
  if (favorites.length > 0 && closes.length === 0) {
    throw new Error(
      `None of the ${favorites.length} watchlist lots could be looked up; the Mac.Bid lot API may have changed`
    );
  }
  return closes;
}
