import {
  MacBidAuthError,
  MacBidUnavailableError,
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

/**
 * With at least this many lots and none of them readable, the lot endpoint has
 * likely moved, and the build fails rather than drop every watchlist event.
 * Below it, all lots failing is as likely to be lots that were removed (one
 * watched lot, taken down), and the rest of the feed must keep updating.
 */
export const MIN_LOTS_FOR_API_CHANGE = 3;

/** Longest wait before retrying a lot Mac.Bid rate-limited or failed on. */
export const MAX_RETRY_WAIT_MS = 5_000;
const DEFAULT_RETRY_WAIT_MS = 1_000;

export interface WatchlistClose {
  favorite: WatchlistFull;
  closes: Date;
}

export interface ResolveOptions {
  concurrency?: number;
  warn?: (message: string) => void;
  /**
   * Each lot's last close time read from Mac.Bid, kept between builds. Used
   * when a lot's lookup is still unavailable after a retry, instead of failing
   * the build. Updated in place; lots no longer watched are dropped.
   */
  lastKnown?: Map<number, Date>;
  /** For tests. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Settle every promise, then return all values or throw. Nothing is left
 * running when this returns, so callers holding a lock can release it safely.
 * A sign-in failure wins over other errors, so the session is dealt with.
 */
export async function settleAll<T extends readonly unknown[]>(
  promises: readonly [...{ [K in keyof T]: Promise<T[K]> }]
): Promise<T> {
  const settled = await Promise.allSettled(promises);
  const failures = settled.flatMap((result) =>
    result.status === "rejected" ? [result.reason as unknown] : []
  );
  if (failures.length > 0) {
    throw failures.find((error) => error instanceof MacBidAuthError) ?? failures[0];
  }
  return settled.map(
    (result) => (result as PromiseFulfilledResult<unknown>).value
  ) as unknown as T;
}

/**
 * `fn` over `items`, at most `limit` at a time, results in input order. After
 * a failure no new item is started; once the ones already running have
 * finished, the first failure is thrown.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  let firstError: unknown;
  const worker = async (): Promise<void> => {
    while (!failed && next < items.length) {
      const index = next++;
      try {
        results[index] = await fn(items[index]!, index);
      } catch (error) {
        if (!failed) {
          failed = true;
          firstError = error;
        }
      }
    }
  };
  const workers = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workers }, worker));
  if (failed) {
    throw firstError;
  }
  return results;
}

/**
 * Each watchlist item with its lot's real close time.
 *
 * - A lot that cannot be read (removed, or an answer without a usable
 *   `end_time`) is skipped with a warning, as one odd item must not take the
 *   whole feed down.
 * - A lot Mac.Bid is rate-limiting or failing on is retried once; if it still
 *   fails, its last known close time is used, and without one the error is
 *   thrown so the feed keeps its previous events.
 * - Sign-in errors are thrown as they are, for their usual handling.
 * - If a watchlist of `MIN_LOTS_FOR_API_CHANGE` or more lots has none that can
 *   be read, the lot endpoint has likely changed: that is thrown too.
 *
 * `expected_close_date` is never used as a fallback: it is known to be wrong.
 */
export async function resolveWatchlistCloses(
  favorites: readonly WatchlistFull[],
  getLot: (lotId: number) => Promise<LotStatus>,
  {
    concurrency = LOT_LOOKUP_CONCURRENCY,
    warn = console.warn,
    lastKnown,
    sleep = defaultSleep,
  }: ResolveOptions = {}
): Promise<WatchlistClose[]> {
  const fetchLot = async (lotId: number): Promise<LotStatus> => {
    try {
      return await getLot(lotId);
    } catch (error) {
      if (!(error instanceof MacBidUnavailableError)) {
        throw error;
      }
      await sleep(
        Math.min(error.retryAfterMs ?? DEFAULT_RETRY_WAIT_MS, MAX_RETRY_WAIT_MS)
      );
      return await getLot(lotId);
    }
  };

  const looked = await mapWithConcurrency(
    favorites,
    concurrency,
    async (favorite): Promise<WatchlistClose | null> => {
      const lotId = favorite.auction_lot_id;
      try {
        const lot = await fetchLot(lotId);
        // get_lot has checked end_time is an ISO instant with a zone
        const closes = new Date(lot.end_time);
        lastKnown?.set(lotId, closes);
        return { favorite, closes };
      } catch (error) {
        if (error instanceof MacBidAuthError) {
          throw error;
        }
        const reason = error instanceof Error ? error.message : String(error);
        if (error instanceof MacBidUnavailableError) {
          const previous = lastKnown?.get(lotId);
          if (!previous) {
            throw error;
          }
          warn(
            `Watchlist item ${lotId}: using its last known close time (${reason})`
          );
          return { favorite, closes: previous };
        }
        warn(`Skipping watchlist item ${lotId}: ${reason}`);
        return null;
      }
    }
  );

  if (lastKnown) {
    const watched = new Set(favorites.map((favorite) => favorite.auction_lot_id));
    for (const lotId of lastKnown.keys()) {
      if (!watched.has(lotId)) {
        lastKnown.delete(lotId);
      }
    }
  }

  const closes = looked.filter((item): item is WatchlistClose => item !== null);
  if (favorites.length >= MIN_LOTS_FOR_API_CHANGE && closes.length === 0) {
    throw new Error(
      `None of the ${favorites.length} watchlist lots could be looked up; the Mac.Bid lot API may have changed`
    );
  }
  return closes;
}
