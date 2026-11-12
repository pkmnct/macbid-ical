import ical, { type ICalCalendar } from "ical-generator";

const CALENDAR_TIMEZONE = "America/New_York";

/**
 * No calendar-wide timezone on purpose: with one set, ical-generator writes
 * Date values as floating times in the server's own timezone (UTC in the
 * container), which shifts every event. Without it they are written as UTC
 * instants, which calendar apps show correctly anywhere.
 */
export function createMacbidCalendar(): ICalCalendar {
  return ical({ name: "Mac.Bid Watchlist" });
}

/** All-day event on today so calendar apps surface that sign-in is required. */
export function addAuthRequiredEvent(
  calendar: ICalCalendar,
  loginUrl: string
): void {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);

  calendar.createEvent({
    start,
    end,
    // A stable id lets calendar apps update an event instead of duplicating it
    id: "macbid-sign-in-required",
    allDay: true,
    timezone: CALENDAR_TIMEZONE,
    summary: "Mac.Bid Sign-In Required",
    description: `This calendar is not signed in to Mac.Bid, so watchlist and pickup updates are paused. Sign in to restore updates:\n${loginUrl}`,
    url: loginUrl,
  });
}

export function sendCalendarResponse(
  res: import("node:http").ServerResponse,
  body: string,
  headOnly = false
): void {
  res.writeHead(200, {
    "Content-Type": "text/calendar; charset=utf-8",
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(headOnly ? undefined : body);
}
