import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ActiveItem, Building, Location } from "macbid-ts-api";
import {
  buildPickupEvents,
  parseStoreHours,
  resolvePickupDay,
} from "./pickupEvents.js";

// Robinson, as Mac.Bid's /buildings answers
const ROBINSON_HOURS =
  "Monday 12:00pm - 6:00pm<br>\r\nTuesday 12:00pm - 8:00pm<br>\r\nWednesday 12:00pm - 6:00pm<br>\r\nThursday 12:00pm - 8:00pm<br>\r\nFriday 12:00pm - 6:00pm<br/><br/><strong>Firm Auction License:</strong><br/>#AY002525";
const hours = parseStoreHours(ROBINSON_HOURS);
const NY = "America/New_York";

const eastern = (date: Date) =>
  date.toLocaleString("en-US", {
    timeZone: NY,
    weekday: "short",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });

const window = (abandon: string) => {
  const day = resolvePickupDay(abandon, hours, NY);
  assert.ok(day, `no pickup day for ${abandon}`);
  return `${eastern(day.start)} to ${eastern(day.end)}`;
};

describe("parseStoreHours", () => {
  it("reads the weekday lines and ignores the rest", () => {
    assert.equal(hours.size, 5);
    assert.deepEqual(hours.get("Tuesday"), { open: "12:00pm", close: "8:00pm" });
    assert.equal(hours.get("Saturday"), undefined);
  });
});

describe("resolvePickupDay", () => {
  it("collects on the abandon date's own day (lot 3199L: Monday 11/16)", () => {
    assert.equal(window("2026-11-16T00:00:00.000Z"), "Mon, 11/16, 12:00 PM EST to Mon, 11/16, 6:00 PM EST");
  });

  it("uses the previous open day when the store is closed on the last day", () => {
    assert.equal(window("2026-11-15T00:00:00.000Z"), "Fri, 11/13, 12:00 PM EST to Fri, 11/13, 6:00 PM EST");
    assert.equal(window("2026-11-22T00:00:00.000Z"), "Fri, 11/20, 12:00 PM EST to Fri, 11/20, 6:00 PM EST");
  });

  it("uses daylight time in summer", () => {
    assert.equal(window("2026-07-20T00:00:00.000Z"), "Mon, 7/20, 12:00 PM EDT to Mon, 7/20, 6:00 PM EDT");
  });

  it("ends the window at an abandon time that falls inside the opening hours", () => {
    const day = resolvePickupDay("2026-11-18T15:00:00.000Z", hours, NY);
    assert.equal(window("2026-11-18T15:00:00.000Z"), "Wed, 11/18, 12:00 PM EST to Wed, 11/18, 3:00 PM EST");
    assert.equal(day?.endsAtAbandon, true);
  });

  it("goes back a day when the abandon time is before the store opens", () => {
    assert.equal(window("2026-11-18T10:00:00.000Z"), "Tue, 11/17, 12:00 PM EST to Tue, 11/17, 8:00 PM EST");
  });

  it("treats a midnight closing time as the end of that day", () => {
    const lateHours = parseStoreHours("Friday 10:00am - 12:00am");
    const day = resolvePickupDay("2026-11-13T00:00:00.000Z", lateHours, NY);
    assert.ok(day);
    assert.equal(`${eastern(day.start)} to ${eastern(day.end)}`, "Fri, 11/13, 10:00 AM EST to Sat, 11/14, 12:00 AM EST");
    assert.ok(day.end > day.start);
  });

  it("gives nothing for a store without hours or an unreadable date", () => {
    assert.equal(resolvePickupDay("2026-11-16T00:00:00.000Z", new Map(), NY), null);
    assert.equal(resolvePickupDay("nope", hours, NY), null);
  });
});

describe("buildPickupEvents", () => {
  const location = {
    id: 23, name: "Robinson - A", address: "800 Vista Park Drive", city_state: "Pittsburgh, PA",
    zip_code: "15205", hours: ROBINSON_HOURS, building_id: 15,
  } as unknown as Location;
  const building = {
    id: 15, name: "Robinson", address: "800 Vista Park Drive", city_state: "Pittsburgh, PA",
    zip_code: "15205", hours: ROBINSON_HOURS,
  } as unknown as Building;
  const item = (id: number, abandon: string, slot: string) =>
    ({
      id, current_location_id: 23, auction_abandon_date: abandon, warehouse_location: slot,
      product_name: `Item ${id}`, lot_number: `${id}L`,
    }) as unknown as ActiveItem;

  it("makes one event per pickup window and lists the warehouse slots", () => {
    const events = buildPickupEvents(
      [item(1, "2026-11-16T00:00:00.000Z", "RO-B"), item(2, "2026-11-16T00:00:00.000Z", "RO-A")],
      [location],
      [building],
    );
    assert.equal(events.length, 1);
    const event = events[0]!;
    assert.equal(event.summary, "Mac.Bid Pickup: Robinson");
    assert.equal(eastern(event.start), "Mon, 11/16, 12:00 PM EST");
    assert.ok(event.description.indexOf("RO-A - Item 2") < event.description.indexOf("RO-B - Item 1"));
  });

  it("makes separate events for different pickup days", () => {
    const events = buildPickupEvents(
      [item(1, "2026-11-16T00:00:00.000Z", "RO-A"), item(2, "2026-11-18T00:00:00.000Z", "RO-B")],
      [location],
      [building],
    );
    assert.equal(events.length, 2);
  });
});
