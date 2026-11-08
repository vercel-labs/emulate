import type { PriceInterval } from "./entities.js";

const DAY = 86400;

function daysInMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/**
 * The `n`th billing boundary after `anchor`, in Unix seconds. Months and years are counted on
 * the UTC calendar from the anchor's day of month, so an anchor on the 31st bills on the last
 * day of shorter months and returns to the 31st when it can (Jan 31, Feb 28, Mar 31). The time
 * of day of the anchor is kept.
 */
export function periodBoundary(anchor: number, interval: PriceInterval, intervalCount: number, n: number): number {
  const steps = intervalCount * n;
  if (interval === "day") return anchor + steps * DAY;
  if (interval === "week") return anchor + steps * 7 * DAY;

  const start = new Date(anchor * 1000);
  const months = interval === "year" ? steps * 12 : steps;
  const total = start.getUTCFullYear() * 12 + start.getUTCMonth() + months;
  const year = Math.floor(total / 12);
  const month = total - year * 12;
  const day = Math.min(start.getUTCDate(), daysInMonth(year, month));
  const ms = Date.UTC(
    year,
    month,
    day,
    start.getUTCHours(),
    start.getUTCMinutes(),
    start.getUTCSeconds(),
    start.getUTCMilliseconds(),
  );
  return Math.floor(ms / 1000);
}

/** The first billing boundary of `anchor` strictly after `from`: the end of the period `from` falls in. */
export function nextPeriodEnd(anchor: number, interval: PriceInterval, intervalCount: number, from: number): number {
  let n = 1;
  let boundary = periodBoundary(anchor, interval, intervalCount, n);
  while (boundary <= from) {
    n += 1;
    boundary = periodBoundary(anchor, interval, intervalCount, n);
  }
  return boundary;
}
