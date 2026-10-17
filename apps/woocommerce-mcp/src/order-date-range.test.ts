import assert from "node:assert/strict";
import { test } from "node:test";
import { orderDateRange } from "./order-date-range.js";

test("a requested calendar day uses local midnight boundaries, including DST", () => {
  for (const [date, timezone, start, end] of [
    ["2026-10-17", "Asia/Kolkata", "2026-10-16T18:30:00.000Z", "2026-10-17T18:30:00.000Z"],
    ["2026-03-08", "America/New_York", "2026-03-08T05:00:00.000Z", "2026-03-09T04:00:00.000Z"],
    ["2026-11-01", "America/New_York", "2026-11-01T04:00:00.000Z", "2026-11-02T05:00:00.000Z"],
    ["2026-10-04", "Australia/Lord_Howe", "2026-10-03T13:30:00.000Z", "2026-10-04T13:00:00.000Z"],
    ["2026-11-01", "America/Havana", "2026-11-01T04:00:00.000Z", "2026-11-02T05:00:00.000Z"],
    ["2026-03-08", "America/Havana", "2026-03-08T05:00:00.000Z", "2026-03-09T04:00:00.000Z"],
    ["2026-12-31", "UTC", "2026-12-31T00:00:00.000Z", "2027-01-01T00:00:00.000Z"],
  ]) {
    assert.deepEqual(orderDateRange(date, timezone), { date, timezone, start, end });
  }
});

test("dates split by a backward transition across midnight are rejected instead of returning incorrect orders", () => {
  for (const [date, timezone] of [
    ["2010-03-04", "Antarctica/Casey"], ["2010-03-05", "Antarctica/Casey"],
    ["1988-10-29", "America/Goose_Bay"], ["1988-10-30", "America/Goose_Bay"],
  ]) assert.throws(() => orderDateRange(date, timezone), /non-contiguous/i);
});

test("today is determined at execution time in the requested timezone", () => {
  assert.deepEqual(orderDateRange("today", "Asia/Kolkata", new Date("2026-10-16T18:29:59Z")), {
    date: "2026-10-16", timezone: "Asia/Kolkata",
    start: "2026-10-15T18:30:00.000Z", end: "2026-10-16T18:30:00.000Z",
  });
  assert.equal(orderDateRange("today", "Asia/Kolkata", new Date("2026-10-16T18:30:00Z")).date, "2026-10-17");
  assert.equal(orderDateRange("today", "America/New_York", new Date("2026-11-01T03:59:59Z")).date, "2026-10-31");
  assert.equal(orderDateRange("today", "America/New_York", new Date("2026-11-01T04:00:00Z")).date, "2026-11-01");
  for (const [date, timezone] of [
    ["2026-02-30", "UTC"], ["tomorrow", "UTC"], ["2026-10-17", "Mars/Olympus"],
    ["2026-10-17", "+05:30"], ["2011-12-30", "Pacific/Apia"],
  ]) assert.throws(() => orderDateRange(date, timezone), /date|timezone/i);
});
