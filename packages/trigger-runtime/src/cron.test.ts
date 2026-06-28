// cron.test.ts — frozen deterministic tests for nextRun (node:test).
// All cases use a FIXED `from` and assert the exact expected next Date.
// No Date.now(), no randomness.

import { test } from "node:test";
import assert from "node:assert/strict";
import { nextRun, isValidCronShape } from "./cron.ts";

// helper: build a Date in local time from [Y, M0, D, H, m, s]
function dt(y: number, mo: number, d: number, h: number, mi: number, s = 0): Date {
  return new Date(y, mo, d, h, mi, s, 0);
}
// expected as ISO-ish local components -> compare via getTime using same dt()
function eq(actual: Date, expected: Date): void {
  assert.equal(actual.getTime(), expected.getTime());
}

test("* * * * * -> next minute boundary", () => {
  eq(nextRun("* * * * *", dt(2024, 0, 1, 12, 0, 30)), dt(2024, 0, 1, 12, 1, 0));
});

test("* * * * * exactly on boundary rolls to next minute", () => {
  eq(nextRun("* * * * *", dt(2024, 0, 1, 12, 5, 0)), dt(2024, 0, 1, 12, 6, 0));
});

test("*/5 * * * * jumps to next 5-minute slot (after 12:00:30 -> 12:05)", () => {
  eq(nextRun("*/5 * * * *", dt(2024, 0, 1, 12, 0, 30)), dt(2024, 0, 1, 12, 5, 0));
});

test("*/5 * * * * from 12:04 -> 12:05", () => {
  eq(nextRun("*/5 * * * *", dt(2024, 0, 1, 12, 4, 0)), dt(2024, 0, 1, 12, 5, 0));
});

test("*/5 * * * * from 12:05 (on slot) -> 12:10", () => {
  eq(nextRun("*/5 * * * *", dt(2024, 0, 1, 12, 5, 0)), dt(2024, 0, 1, 12, 10, 0));
});

test("list 0,15,30,45 from 12:07 -> 12:15", () => {
  eq(nextRun("0,15,30,45 * * * *", dt(2024, 0, 1, 12, 7, 0)), dt(2024, 0, 1, 12, 15, 0));
});

test("range+step 10-20/5 minutes -> {10,15,20}, from 12:12 -> 12:15", () => {
  eq(nextRun("10-20/5 * * * *", dt(2024, 0, 1, 12, 12, 0)), dt(2024, 0, 1, 12, 15, 0));
});

test("fixed hour:min 30 3 * * * earlier same day", () => {
  eq(nextRun("30 3 * * *", dt(2024, 0, 1, 2, 0, 0)), dt(2024, 0, 1, 3, 30, 0));
});

test("fixed hour:min 30 3 * * * after today's slot -> next day", () => {
  eq(nextRun("30 3 * * *", dt(2024, 0, 1, 4, 0, 0)), dt(2024, 0, 2, 3, 30, 0));
});

test("yearly 0 0 1 1 * from mid-2024 -> 2025-01-01 00:00", () => {
  eq(nextRun("0 0 1 1 *", dt(2024, 5, 1, 12, 0, 0)), dt(2025, 0, 1, 0, 0, 0));
});

test("dow-only: 0 12 * * 1 (Mondays). 2024-01-01 is Monday -> same day 12:00", () => {
  // 2024-01-01 was a Monday (getDay() === 1)
  eq(nextRun("0 12 * * 1", dt(2024, 0, 1, 10, 0, 0)), dt(2024, 0, 1, 12, 0, 0));
});

test("dow-only: 0 12 * * 1 after Monday's slot -> next Monday", () => {
  eq(nextRun("0 12 * * 1", dt(2024, 0, 1, 13, 0, 0)), dt(2024, 0, 8, 12, 0, 0));
});

test("dow 7 normalized to 0 (Sunday): 0 9 * * 7 from Saturday 2024-01-06 -> Sun 01-07 09:00", () => {
  eq(nextRun("0 9 * * 7", dt(2024, 0, 6, 10, 0, 0)), dt(2024, 0, 7, 9, 0, 0));
});

test("both dom and dow restricted -> OR semantics: 0 0 15 * 1 (15th OR Monday)", () => {
  // 2024-01-14 is Sunday; 2024-01-15 is Monday. From 2024-01-13 23:55 ->
  // next match is 15th (which is also Monday) at 00:00. But 2024-01-15 00:00.
  // The 15th matches dom; it also is Monday (dow). Either way -> 01-15 00:00.
  eq(nextRun("0 0 15 * 1", dt(2024, 0, 13, 23, 55, 0)), dt(2024, 0, 15, 0, 0, 0));
});

test("both restricted OR: 0 0 16 * 1 from 01-15 00:01 -> Monday 01-15 is past, next is 16th (Tue) OR Monday 01-22", () => {
  // dom=16 (Tue 01-16) matches before the next Monday (01-22). So -> 01-16 00:00.
  eq(nextRun("0 0 16 * 1", dt(2024, 0, 15, 0, 1, 0)), dt(2024, 0, 16, 0, 0, 0));
});

test("month wrap: 0 0 1 3 * from 2024-11-15 -> 2025-03-01 00:00", () => {
  eq(nextRun("0 0 1 3 *", dt(2024, 10, 15, 12, 0, 0)), dt(2025, 2, 1, 0, 0, 0));
});

test("6-field seconds: */2 * * * * * from 12:00:00 -> 12:00:02", () => {
  eq(nextRun("*/2 * * * * *", dt(2024, 0, 1, 12, 0, 0)), dt(2024, 0, 1, 12, 0, 2));
});

test("6-field seconds: exact second 5 * * * * * from 12:00:00 -> 12:00:05", () => {
  eq(nextRun("5 * * * * *", dt(2024, 0, 1, 12, 0, 0)), dt(2024, 0, 1, 12, 0, 5));
});

test("6-field seconds: 30 0 * * * * from 12:00:00 -> 12:00:30", () => {
  eq(nextRun("30 0 * * * *", dt(2024, 0, 1, 12, 0, 0)), dt(2024, 0, 1, 12, 0, 30));
});

test("isValidCronShape accepts 5 and 6 fields, rejects garbage", () => {
  assert.equal(isValidCronShape("* * * * *"), true);
  assert.equal(isValidCronShape("*/5 * * * *"), true);
  assert.equal(isValidCronShape("*/2 * * * * *"), true);
  assert.equal(isValidCronShape("0 0 1 1 1"), true);
  assert.equal(isValidCronShape("* * * *"), false);
  assert.equal(isValidCronShape("* * * * * * *"), false);
  assert.equal(isValidCronShape("60 * * * *"), false);
  assert.equal(isValidCronShape("* 24 * * *"), false);
});

test("throws on invalid cron (bad field count)", () => {
  assert.throws(() => nextRun("* * * *", new Date(2024, 0, 1)));
});