// Calendar periods in the person's time zone: a « day » is their midnight
// to midnight, a week starts on Monday, and the hours of a day that changes
// clocks are 23 or 25. Everything is computed from Intl, with no library.

export type Period = "day" | "week" | "month" | "year";
export type Bucket = "hour" | "day" | "month";
export const PERIODS: readonly Period[] = ["day", "week", "month", "year"];
export const BUCKET_OF: Record<Period, Bucket> = { day: "hour", week: "day", month: "day", year: "month" };

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let found = formatters.get(tz);
  if (!found) {
    found = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      weekday: "short",
    });
    formatters.set(tz, found);
  }
  return found;
}

/// A time zone Intl knows, or null.
export function validTimeZone(tz: unknown): string | null {
  if (typeof tz !== "string" || tz.length === 0 || tz.length > 64) return null;
  try {
    formatter(tz);
    return tz;
  } catch {
    return null;
  }
}

export function defaultTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number; // 0 = Monday
}

export function localParts(ms: number, tz: string): LocalParts {
  const parts: Record<string, string> = {};
  for (const part of formatter(tz).formatToParts(new Date(ms))) parts[part.type] = part.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAYS.indexOf(parts.weekday),
  };
}

/// How far ahead of UTC the zone's clocks are at this instant, in ms.
function offsetAt(ms: number, tz: string): number {
  const p = localParts(ms, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/// The instant the zone's clocks show this date and hour. Month and day
/// may overflow (day 32 is the 1st of the next month), as with Date.UTC.
export function zonedTime(tz: string, year: number, month: number, day: number, hour = 0): number {
  const wall = Date.UTC(year, month - 1, day, hour);
  const first = wall - offsetAt(wall, tz);
  const second = offsetAt(first, tz);
  const adjusted = wall - second;
  // In a gap (clocks jump forward past this hour): the first instant after.
  return offsetAt(adjusted, tz) === second ? adjusted : first;
}

export interface PeriodRange {
  period: Period;
  from: number;
  to: number;
  bucket: Bucket;
  /// The start of each bucket, in order; the last one ends at `to`.
  buckets: number[];
}

/// The period `offset` periods before the one `now` is in (0: the current).
export function periodRange(period: Period, tz: string, offset = 0, now = Date.now()): PeriodRange {
  const today = localParts(now, tz);
  let start: [number, number, number];
  let end: [number, number, number];
  switch (period) {
    case "day":
      start = [today.year, today.month, today.day - offset];
      end = [today.year, today.month, today.day - offset + 1];
      break;
    case "week": {
      const monday = today.day - today.weekday - 7 * offset;
      start = [today.year, today.month, monday];
      end = [today.year, today.month, monday + 7];
      break;
    }
    case "month":
      start = [today.year, today.month - offset, 1];
      end = [today.year, today.month - offset + 1, 1];
      break;
    case "year":
      start = [today.year - offset, 1, 1];
      end = [today.year - offset + 1, 1, 1];
      break;
  }
  // Normalised through UTC dates, so « the 0th of March » is a real day.
  const norm = ([y, m, d]: [number, number, number]) => {
    const date = new Date(Date.UTC(y, m - 1, d));
    return [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()] as const;
  };
  const [sy, sm, sd] = norm(start);
  const from = zonedTime(tz, sy, sm, sd);
  const [ey, em, ed] = norm(end);
  const to = zonedTime(tz, ey, em, ed);
  const bucket = BUCKET_OF[period];
  const buckets: number[] = [];
  if (bucket === "hour") {
    for (let t = from; t < to; t += 3600 * 1000) buckets.push(t);
  } else {
    for (let i = 0; ; i += 1) {
      const t = bucket === "day" ? zonedTime(tz, sy, sm, sd + i) : zonedTime(tz, sy, sm + i, 1);
      if (t >= to) break;
      buckets.push(t);
    }
  }
  return { period, from, to, bucket, buckets };
}

/// The bucket an instant falls in: the last start at or before it.
export function bucketIndex(buckets: number[], ms: number): number {
  let low = 0;
  let high = buckets.length - 1;
  if (high < 0 || ms < buckets[0]) return -1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (buckets[mid] <= ms) low = mid;
    else high = mid - 1;
  }
  return low;
}
