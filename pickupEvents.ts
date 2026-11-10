import type { ActiveItem, Building, Location } from "macbid-ts-api";

const TIMEZONE = "America/New_York";

const HOURS_LINE =
  /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\s+(\d{1,2}:\d{2}(?:am|pm))\s*-\s*(\d{1,2}:\d{2}(?:am|pm))$/i;

export interface PickupCalendarEvent {
  summary: string;
  start: Date;
  end: Date;
  location: string;
  description: string;
}

/** "3:30pm" in the given timezone, matching the store-hours format. */
export function formatTime12h(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${get("hour")}:${get("minute")}${get("dayPeriod").toLowerCase()}`;
}

export function parseStoreHours(
  hoursHtml: string,
): Map<string, { open: string; close: string }> {
  const map = new Map<string, { open: string; close: string }>();
  const text = hoursHtml
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\r/g, "");

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    const match = trimmed.match(HOURS_LINE);
    if (match) {
      map.set(match[1]!, {
        open: match[2]!.toLowerCase(),
        close: match[3]!.toLowerCase(),
      });
    }
  }

  return map;
}

export function abandonDateInTimeZone(
  iso: string,
  tz: string,
): { date: string; weekday: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "long",
  }).formatToParts(new Date(iso));

  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";

  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    weekday: get("weekday"),
  };
}

export function parseTime12h(time: string): { hour: number; minute: number } {
  const match = time
    .trim()
    .toLowerCase()
    .match(/^(\d{1,2}):(\d{2})(am|pm)$/);
  if (!match) {
    throw new Error(`Invalid time: ${time}`);
  }

  let hour = parseInt(match[1]!, 10);
  const minute = parseInt(match[2]!, 10);
  if (match[3] === "pm" && hour !== 12) {
    hour += 12;
  }
  if (match[3] === "am" && hour === 12) {
    hour = 0;
  }

  return { hour, minute };
}

export function zonedLocalToDate(
  dateStr: string,
  time12h: string,
  timeZone: string,
): Date {
  const { hour, minute } = parseTime12h(time12h);
  const year = parseInt(dateStr.slice(0, 4), 10);
  const month = parseInt(dateStr.slice(5, 7), 10);
  const day = parseInt(dateStr.slice(8, 10), 10);

  let utc = Date.UTC(year, month - 1, day, hour, minute, 0);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const targetUtc = Date.UTC(year, month - 1, day, hour, minute, 0);

  for (let i = 0; i < 4; i++) {
    const parts = Object.fromEntries(
      formatter
        .formatToParts(new Date(utc))
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, part.value]),
    );
    const actualUtc = Date.UTC(
      parseInt(parts.year!, 10),
      parseInt(parts.month!, 10) - 1,
      parseInt(parts.day!, 10),
      parseInt(parts.hour!, 10),
      parseInt(parts.minute!, 10),
      parseInt(parts.second!, 10),
    );
    utc += targetUtc - actualUtc;
  }

  return new Date(utc);
}

function addDaysInTimeZone(
  dateStr: string,
  days: number,
  timeZone: string,
): string {
  const noon = zonedLocalToDate(dateStr, "12:00pm", timeZone);
  const shifted = new Date(noon.getTime() + days * 86_400_000);
  return abandonDateInTimeZone(shifted.toISOString(), timeZone).date;
}

/**
 * The last day the store is open before items are abandoned: the abandon day
 * itself counts only if the store opens before the abandon time, and then the
 * window ends at whichever comes first, closing or abandonment.
 */
export function resolvePickupDay(
  abandonIso: string,
  hoursMap: Map<string, { open: string; close: string }>,
  tz: string,
): {
  date: string;
  weekday: string;
  hours: { open: string; close: string };
  start: Date;
  end: Date;
  /** The window ends at the abandon time, before the store closes. */
  endsAtAbandon: boolean;
} | null {
  const abandonAt = new Date(abandonIso).getTime();
  if (Number.isNaN(abandonAt)) {
    return null;
  }
  let { date, weekday } = abandonDateInTimeZone(abandonIso, tz);

  for (let i = 0; i < 8; i++) {
    const hours = hoursMap.get(weekday);
    if (hours) {
      const opensAt = zonedLocalToDate(date, hours.open, tz).getTime();
      const closesAt = zonedLocalToDate(date, hours.close, tz).getTime();
      if (opensAt < abandonAt) {
        return {
          date,
          weekday,
          hours,
          start: new Date(opensAt),
          end: new Date(Math.min(closesAt, abandonAt)),
          endsAtAbandon: abandonAt < closesAt,
        };
      }
    }
    date = addDaysInTimeZone(date, -1, tz);
    weekday = abandonDateInTimeZone(
      zonedLocalToDate(date, "12:00pm", tz).toISOString(),
      tz,
    ).weekday;
  }

  return null;
}

export function buildPickupEvents(
  activeItems: ActiveItem[],
  locations: Location[],
  buildings: Building[],
): PickupCalendarEvent[] {
  const locationById = new Map(
    locations.map((location) => [location.id, location]),
  );
  const buildingById = new Map(
    buildings.map((building) => [building.id, building]),
  );
  const groups = new Map<
    number,
    { items: ActiveItem[]; locationIds: Set<number> }
  >();

  for (const item of activeItems) {
    const location = locationById.get(item.current_location_id);
    if (!location) {
      console.warn(
        `Unknown location ${item.current_location_id} for item ${item.id}`,
      );
      continue;
    }

    const group = groups.get(location.building_id) ?? {
      items: [],
      locationIds: new Set<number>(),
    };
    group.items.push(item);
    group.locationIds.add(location.id);
    groups.set(location.building_id, group);
  }

  const events: PickupCalendarEvent[] = [];

  for (const [buildingId, { items, locationIds }] of groups) {
    const building = buildingById.get(buildingId);
    const fallbackLocation = locationById.get([...locationIds][0]!);
    if (!fallbackLocation) {
      continue;
    }

    const name = building?.name ?? fallbackLocation.name;
    const address = building
      ? `${building.address}, ${building.city_state} ${building.zip_code}`
      : `${fallbackLocation.address}, ${fallbackLocation.city_state} ${fallbackLocation.zip_code}`;
    const hoursHtml = building?.hours ?? fallbackLocation.hours;
    const hoursMap = parseStoreHours(hoursHtml);
    if (hoursMap.size === 0) {
      console.warn(`No hours for building ${name} (${buildingId})`);
      continue;
    }

    // One event per pickup day. Items abandoned at different times can share a
    // day: they share its event (the id is derived from its start), and the
    // window ends at the earliest abandonment so it is right for every item.
    type PickupDay = NonNullable<ReturnType<typeof resolvePickupDay>>;
    const days = new Map<
      string,
      { pickupDay: PickupDay; dayItems: ActiveItem[]; dayLocationIds: Set<number> }
    >();
    for (const item of items) {
      const pickupDay = resolvePickupDay(
        item.auction_abandon_date,
        hoursMap,
        TIMEZONE,
      );
      if (!pickupDay) {
        console.warn(`Could not resolve pickup day for building ${name}`);
        continue;
      }
      const day = days.get(pickupDay.date) ?? {
        pickupDay,
        dayItems: [],
        dayLocationIds: new Set<number>(),
      };
      if (pickupDay.end < day.pickupDay.end) {
        day.pickupDay = pickupDay;
      }
      day.dayItems.push(item);
      day.dayLocationIds.add(item.current_location_id);
      days.set(pickupDay.date, day);
    }

    for (const { pickupDay, dayItems, dayLocationIds } of days.values()) {
      const locationNames = [...dayLocationIds]
        .map((id) => locationById.get(id)!.name)
        .sort((a, b) => a.localeCompare(b));
      const warehouseSlots = dayItems
        .sort((a, b) => a.warehouse_location.localeCompare(b.warehouse_location))
        .map(
          (item) =>
            `${item.warehouse_location} - ${item.product_name} - ${item.lot_number}`,
        );
      const hoursLine = pickupDay.endsAtAbandon
        ? `${pickupDay.weekday} ${pickupDay.hours.open} - ${formatTime12h(pickupDay.end, TIMEZONE)} (items are abandoned then; store closes ${pickupDay.hours.close})`
        : `${pickupDay.weekday} ${pickupDay.hours.open} - ${pickupDay.hours.close}`;
      const locationsLine =
        locationNames.length > 1
          ? `${locationNames.join(", ")}\n`
          : locationNames.length === 1 && locationNames[0] !== name
            ? `${locationNames[0]}\n`
            : "";

      events.push({
        summary: `Mac.Bid Pickup: ${name}`,
        start: pickupDay.start,
        end: pickupDay.end,
        location: address,
        description: `${name}\n${locationsLine}${hoursLine}\n\n${warehouseSlots.join("\n")}`,
      });
    }
  }

  return events;
}
