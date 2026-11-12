/**
 * Mac.Bid writes its times as ISO strings that end in "Z" but are not UTC:
 * the digits are the Eastern wall-clock time the site shows (a lot with
 * `closed_date: "2026-11-11T19:38:53.000Z"` is shown as "7:38 PM", and its
 * last bid, written as a real UTC instant, is 2026-11-12T00:37:53Z). Reading
 * them as UTC, or adding an hour for daylight saving, puts events at the wrong
 * time. This turns those digits into the real instant.
 */
export const MACBID_TIMEZONE = "America/New_York";

export function macbidWallClockToDate(
  value: Date | string,
  timeZone: string = MACBID_TIMEZONE
): Date {
  // new Date(string) keeps the digits in its UTC fields
  const wall = new Date(value);
  if (Number.isNaN(wall.getTime())) {
    return wall;
  }
  const target = wall.getTime();
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });

  // Start from the digits read as UTC and correct by what the zone shows
  let instant = target;
  for (let i = 0; i < 4; i++) {
    const parts = Object.fromEntries(
      formatter
        .formatToParts(new Date(instant))
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, Number(part.value)])
    ) as Record<string, number>;
    const shown = Date.UTC(
      parts.year!,
      parts.month! - 1,
      parts.day!,
      parts.hour!,
      parts.minute!,
      parts.second!
    );
    const difference = target - shown;
    if (difference === 0) {
      break;
    }
    instant += difference;
  }
  return new Date(instant);
}
