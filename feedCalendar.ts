import ical, { type ICalCalendar } from "ical-generator";

const CALENDAR_TIMEZONE = "America/New_York";

export function createMacbidCalendar(): ICalCalendar {
  return ical({
    name: "Mac.Bid Watchlist",
    timezone: CALENDAR_TIMEZONE,
  });
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
    allDay: true,
    timezone: CALENDAR_TIMEZONE,
    summary: "Mac.Bid Sign-In Required",
    description: `This calendar is not signed in to Mac.Bid, so watchlist and pickup updates are paused. Sign in to restore updates:\n${loginUrl}`,
    url: loginUrl,
  });
}

export function sendCalendarResponse(
  res: import("node:http").ServerResponse,
  calendar: ICalCalendar
): void {
  res.writeHead(200, {
    "Content-Type": "text/calendar; charset=utf-8",
  });
  res.end(calendar.toString());
}
