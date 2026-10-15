import { expect, it } from "vitest";
import { cronFromRule, describeCron, nextRuns, parseCron, ruleFromCron } from "./cron.js";

const iso = (runs: number[]) => runs.map((at) => new Date(at).toISOString());
const after = (at: string) => Date.parse(at);

it.each([
  ["", /five fields/u], ["* * * *", /five fields/u], ["* * * * * *", /five fields/u],
  ["60 * * * *", /minute field "60"/u], ["* 24 * * *", /hour field/u], ["* * 0 * *", /day of month field "0"/u],
  ["* * * 13 *", /month field/u], ["* * * * 8", /day of week field "8"/u], ["5-1 * * * *", /minute field "5-1"/u],
  ["*/0 * * * *", /minute field/u], ["a * * * *", /minute field "a"/u], ["1,,2 * * * *", /minute field ""/u],
  ["* * * * MON", /day of week field "MON"/u], [`${"1,".repeat(100)}1 * * * *`, /at most 200/u],
])("refuses %j with a sentence", (expression, message) => {
  expect(() => parseCron(expression)).toThrow(message);
});

it("reads lists, ranges and steps, and 7 as Sunday", () => {
  const spec = parseCron("  */15  9-17/4 1,15 * 5-7 ");
  expect(spec.source).toBe("*/15 9-17/4 1,15 * 5-7");
  expect(spec.minutes).toEqual([0, 15, 30, 45]);
  expect(spec.hours).toEqual([9, 13, 17]);
  expect(spec.weekdays.flatMap((on, day) => on ? [day] : [])).toEqual([0, 5, 6]);
  expect(parseCron("5/20 * * * *").minutes).toEqual([5, 25, 45]);
});

it("matches day of month or day of week when both are restricted, both when either starts with *", () => {
  // Thu 1 Oct 2026: the Fridays and Tuesday the 13th.
  expect(iso(nextRuns("0 0 13 * 5", "UTC", after("2026-10-01T00:00:00Z"), 4))).toEqual(["2026-10-02T00:00:00.000Z", "2026-10-09T00:00:00.000Z", "2026-10-13T00:00:00.000Z", "2026-10-16T00:00:00.000Z"]);
  // Odd days that are Fridays.
  expect(iso(nextRuns("0 0 */2 * 5", "UTC", after("2026-10-01T00:00:00Z"), 2))).toEqual(["2026-10-09T00:00:00.000Z", "2026-10-23T00:00:00.000Z"]);
});

it("answers never for impossible dates and finds a rare one within five years", () => {
  expect(nextRuns("0 0 30 2 *", "UTC", after("2026-10-14T00:00:00Z"), 1)).toEqual([]);
  expect(nextRuns("0 0 31 4,6,9,11 *", "Europe/Berlin", after("2026-10-14T00:00:00Z"), 1)).toEqual([]);
  expect(iso(nextRuns("0 0 29 2 *", "UTC", after("2026-10-14T00:00:00Z"), 1))).toEqual(["2028-02-29T00:00:00.000Z"]);
});

it("runs strictly after the given instant, in order", () => {
  expect(iso(nextRuns("*/30 * * * *", "UTC", after("2026-10-14T09:00:00Z"), 3))).toEqual(["2026-10-14T09:30:00.000Z", "2026-10-14T10:00:00.000Z", "2026-10-14T10:30:00.000Z"]);
  expect(iso(nextRuns("0 9 * * 1,3,5", "Europe/Berlin", after("2026-10-14T08:00:00Z"), 3))).toEqual(["2026-10-16T07:00:00.000Z", "2026-10-19T07:00:00.000Z", "2026-10-21T07:00:00.000Z"]);
});

it("skips a local time that does not exist when clocks spring forward", () => {
  // Berlin: 29 Mar 2026, 02:00 CET becomes 03:00 CEST.
  expect(iso(nextRuns("30 2 * * *", "Europe/Berlin", after("2026-03-28T12:00:00Z"), 2))).toEqual(["2026-03-30T00:30:00.000Z", "2026-03-31T00:30:00.000Z"]);
  expect(iso(nextRuns("0 * * * *", "Europe/Berlin", after("2026-03-29T00:30:00Z"), 2))).toEqual(["2026-03-29T01:00:00.000Z", "2026-03-29T02:00:00.000Z"]);
  expect(iso(nextRuns("0 9 * * *", "Europe/Berlin", after("2026-03-28T12:00:00Z"), 2))).toEqual(["2026-03-29T07:00:00.000Z", "2026-03-30T07:00:00.000Z"]);
  // New York: 8 Mar 2026, 02:00 EST becomes 03:00 EDT.
  expect(iso(nextRuns("30 2 * * *", "America/New_York", after("2026-03-07T12:00:00Z"), 1))).toEqual(["2026-03-09T06:30:00.000Z"]);
});

it("runs an ambiguous local time once, at its first instant, when clocks fall back", () => {
  // Berlin: 25 Oct 2026, 03:00 CEST becomes 02:00 CET; 02:30 happens at 00:30Z and 01:30Z.
  expect(iso(nextRuns("30 2 * * *", "Europe/Berlin", after("2026-10-24T12:00:00Z"), 2))).toEqual(["2026-10-25T00:30:00.000Z", "2026-10-26T01:30:00.000Z"]);
  expect(iso(nextRuns("30 2 * * *", "Europe/Berlin", after("2026-10-25T01:00:00Z"), 1))).toEqual(["2026-10-26T01:30:00.000Z"]);
  expect(iso(nextRuns("0 * * * *", "Europe/Berlin", after("2026-10-25T00:30:00Z"), 2))).toEqual(["2026-10-25T02:00:00.000Z", "2026-10-25T03:00:00.000Z"]);
  expect(iso(nextRuns("0 9 * * *", "Europe/Berlin", after("2026-10-24T12:00:00Z"), 1))).toEqual(["2026-10-25T08:00:00.000Z"]);
  // New York: 1 Nov 2026, 02:00 EDT becomes 01:00 EST.
  expect(iso(nextRuns("30 1 * * *", "America/New_York", after("2026-10-31T12:00:00Z"), 2))).toEqual(["2026-11-01T05:30:00.000Z", "2026-11-02T06:30:00.000Z"]);
});

it("searches years without walking minute by minute", () => {
  const started = performance.now();
  expect(nextRuns("0 0 30 2 *", "America/New_York", 0, 1)).toEqual([]);
  expect(nextRuns("* * * * *", "Europe/Berlin", after("2026-10-14T23:58:30Z"), 5)).toHaveLength(5);
  expect(performance.now() - started).toBeLessThan(1000);
});

it("describes and rebuilds the builder's shapes, and nothing else", () => {
  for (const [expression, sentence] of [
    ["15 * * * *", "Every hour at :15"], ["0 9 * * *", "Every day at 09:00"], ["0 9 * * 1-5", "Every weekday at 09:00"],
    ["0 9 * * 1,3,5", "Every Monday, Wednesday and Friday at 09:00"], ["30 18 * * 0,6", "Every Saturday and Sunday at 18:30"],
    ["0 9 * * 7", "Every Sunday at 09:00"], ["0 9 1 * *", "On day 1 of every month at 09:00"],
  ]) {
    expect(describeCron(expression!)).toBe(sentence);
    expect(describeCron(cronFromRule(ruleFromCron(expression!)!))).toBe(sentence);
  }
  for (const expression of ["*/15 * * * *", "0 9-17 * * *", "0 9 * 1 *", "0 9 1 * 1", "0 9 * * */2", "nonsense"]) expect(describeCron(expression)).toBeUndefined();
  expect(cronFromRule({ frequency: "week", time: "09:00", weekdays: [5, 1, 3] })).toBe("0 9 * * 1,3,5");
  expect(cronFromRule({ frequency: "week", time: "07:05", weekdays: [1, 2, 3, 4, 5] })).toBe("5 7 * * 1-5");
  expect(cronFromRule({ frequency: "month", time: "09:00", day: 31 })).toBe("0 9 31 * *");
});
