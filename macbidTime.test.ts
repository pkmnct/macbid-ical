import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { macbidWallClockToDate, wallClockToDate } from "./macbidTime.js";

const iso = (date: Date) => date.toISOString();

describe("macbidWallClockToDate", () => {
  it("reads Mac.Bid's digits as Eastern time (lot 3199L, in winter)", () => {
    assert.equal(iso(macbidWallClockToDate("2026-11-11T19:33:29.000Z")), "2026-11-12T00:33:29.000Z");
    assert.equal(iso(macbidWallClockToDate("2026-11-11T19:38:53.000Z")), "2026-11-12T00:38:53.000Z");
  });

  it("agrees with the real UTC time of the lot's last bid", () => {
    // winning_bid_id: 2026-11-12T00:37:53.277Z, a minute before closed_date
    const closed = macbidWallClockToDate("2026-11-11T19:38:53.000Z").getTime();
    const lastBid = Date.parse("2026-11-12T00:37:53.277Z");
    assert.equal(Math.round((closed - lastBid) / 1000), 60);
  });

  it("uses daylight time in summer", () => {
    assert.equal(iso(macbidWallClockToDate("2026-07-15T19:00:00.000Z")), "2026-07-15T23:00:00.000Z");
  });

  it("accepts a Date as well as a string", () => {
    assert.equal(iso(macbidWallClockToDate(new Date("2026-11-11T19:00:00.000Z"))), "2026-11-12T00:00:00.000Z");
  });

  it("returns an invalid date for garbage", () => {
    assert.ok(Number.isNaN(macbidWallClockToDate("not a date").getTime()));
  });
});

describe("wallClockToDate", () => {
  const eastern = (month: number, day: number, hour: number, minute = 0) =>
    iso(wallClockToDate({ year: 2026, month, day, hour, minute, second: 0 }, "America/New_York"));

  it("handles midnight as hour 0 of the day", () => {
    assert.equal(eastern(11, 13, 0), "2026-11-13T05:00:00.000Z");
    assert.equal(eastern(7, 13, 0), "2026-07-13T04:00:00.000Z");
    assert.equal(eastern(11, 13, 23, 59), "2026-11-14T04:59:00.000Z");
  });

  it("follows the March change (clocks forward on 8 March 2026)", () => {
    assert.equal(eastern(3, 8, 1, 30), "2026-03-08T06:30:00.000Z"); // EST
    assert.equal(eastern(3, 8, 12), "2026-03-08T16:00:00.000Z"); // EDT
    assert.equal(eastern(3, 8, 2, 30), "2026-03-08T06:30:00.000Z"); // does not exist: an hour earlier
  });

  it("follows the November change (clocks back on 1 November 2026)", () => {
    assert.equal(eastern(11, 1, 0, 30), "2026-11-01T04:30:00.000Z"); // EDT
    assert.equal(eastern(11, 1, 1, 30), "2026-11-01T05:30:00.000Z"); // happens twice: the first
    assert.equal(eastern(11, 1, 12), "2026-11-01T17:00:00.000Z"); // EST
  });
});
