import {
  MacBidAuthError,
  MacBidNotFoundError,
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
 * With at least this many lots and every one of them answering badly (not
 * rate-limited: those did not answer), the lot endpoint has likely moved, and
 * the build fails rather than drop every watchlist event.
 * Below it, all lots failing is as likely to be lots that were removed (one
 * watched lot, taken down), and the rest of the feed must keep updating.
 */
export const MIN_LOTS_FOR_API_CHANGE = 3;

/** Longest wait before retrying a lot Mac.Bid rate-limited or failed on. */
export const MAX_RETRY_WAIT_MS = 5_000;
const DEFAULT_RETRY_WAIT_MS = 1_000;

/**
 * How long a lot's saved close time may stand in for a failed lookup. Past
 * this, a lot that keeps answering badly (say its end_time turned null after
 * it sold) is skipped instead of shown at an old time forever, and a
 * rate-limited one fails the build so calendar apps keep their own copy.
 */
export const MAX_FALLBACK_AGE_MS = 60 * 60 * 1000;

/** A lot's close time and when it was read from Mac.Bid. */
export interface KnownClose {
  closes: Date;
  /** Milliseconds since the epoch. */
  readAt: number;
}

export interface WatchlistClose {
  favorite: WatchlistFull;
  closes: Date;
}

export interface ResolveOptions {
  concurrency?: number;
  warn?: (message: string) => void;
  /**
   * Each lot's last close time read from Mac.Bid, kept between builds. Used
   * when a lot's lookup fails for any reason but a 404 or sign-in, so a passing
   * error does not delete a known event, for up to `MAX_FALLBACK_AGE_MS`.
   * Updated in place; lots no longer watched, gone from Mac.Bid, or saved too
   * long ago are dropped.
   */
  lastKnown?: Map<number, KnownClose>;
  /**
   * Whether the client still has a session. When another request's sign-in
   * failure drops it, lookups fail with a plain "Not authenticated"; those are
   * passed through quietly instead of logged as skipped lots.
   */
  signedIn?: () => boolean;
  /** For tests. */
  sleep?: (ms: number) => Promise<void>;
  /** For tests: the current time in milliseconds. */
  now?: () => number;
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
 * - A lot Mac.Bid no longer has (404) is skipped with a warning.
 * - Any other failure for one lot (a bad answer, a 429 or outage after one
 *   retry) uses the lot's last known close time, if it was read within
 *   `MAX_FALLBACK_AGE_MS`. Without one, a bad answer
 *   skips the lot (one odd item must not take the whole feed down), and an
 *   outage is thrown so the feed keeps its previous events.
 * - Once a lot is still rate-limited after its retry, the remaining lots send
 *   no request: Mac.Bid is limiting us, and more requests (and waits) would
 *   only hold up the build.
 * - Sign-in errors are thrown as they are, for their usual handling.
 * - If every lot of a watchlist of `MIN_LOTS_FOR_API_CHANGE` or more answers
 *   badly (404 or unusable; a rate-limited lot has not answered), the lot
 *   endpoint has likely changed: that is thrown too.
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
    signedIn,
    sleep = defaultSleep,
    now = Date.now,
  }: ResolveOptions = {}
): Promise<WatchlistClose[]> {
  /** Set once a lot is still unavailable after its retry. */
  let limited: MacBidUnavailableError | undefined;
  let badAnswers = 0;

  const fetchLot = async (lotId: number): Promise<LotStatus> => {
    if (limited) {
      throw limited;
    }
    try {
      return await getLot(lotId);
    } catch (error) {
      if (!(error instanceof MacBidUnavailableError) || limited) {
        throw error;
      }
      await sleep(
        Math.min(error.retryAfterMs ?? DEFAULT_RETRY_WAIT_MS, MAX_RETRY_WAIT_MS)
      );
      if (limited) {
        throw limited;
      }
      try {
        return await getLot(lotId);
      } catch (retryError) {
        if (retryError instanceof MacBidUnavailableError) {
          limited ??= retryError;
        }
        throw retryError;
      }
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
        lastKnown?.set(lotId, { closes, readAt: now() });
        return { favorite, closes };
      } catch (error) {
        if (
          error instanceof MacBidAuthError ||
          (signedIn && !signedIn())
        ) {
          // Signed out (here or by another request): the build becomes the
          // sign-in reminder, so these are not lot problems worth logging
          throw error;
        }
        const reason = error instanceof Error ? error.message : String(error);
        if (error instanceof MacBidNotFoundError) {
          lastKnown?.delete(lotId);
          badAnswers++;
          warn(`Skipping watchlist item ${lotId}: ${reason}`);
          return null;
        }
        const unavailable = error instanceof MacBidUnavailableError;
        if (!unavailable) {
          badAnswers++;
        }
        const previous = lastKnown?.get(lotId);
        if (previous && now() - previous.readAt <= MAX_FALLBACK_AGE_MS) {
          // Rate-limited lots are summed up once below, not one line each
          if (!unavailable) {
            warn(`Watchlist item ${lotId}: using its last known close time (${reason})`);
          }
          return { favorite, closes: previous.closes };
        }
        // Too old to stand in for the real time any more
        lastKnown?.delete(lotId);
        if (unavailable) {
          throw error;
        }
        warn(`Skipping watchlist item ${lotId}: ${reason}`);
        return null;
      }
    }
  );

  if (limited) {
    warn(`Mac.Bid is rate-limiting lot lookups (${limited.message}); using last known close times`);
  }

  if (lastKnown) {
    const watched = new Set(favorites.map((favorite) => favorite.auction_lot_id));
    for (const lotId of lastKnown.keys()) {
      if (!watched.has(lotId)) {
        lastKnown.delete(lotId);
      }
    }
  }

  if (
    favorites.length >= MIN_LOTS_FOR_API_CHANGE &&
    badAnswers === favorites.length
  ) {
    throw new Error(
      `None of the ${favorites.length} watchlist lots could be looked up; the Mac.Bid lot API may have changed`
    );
  }
  return looked.filter((item): item is WatchlistClose => item !== null);
}
