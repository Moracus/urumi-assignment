export interface OrderDateRange {
  date: string;
  timezone: string;
  /** Inclusive UTC start and exclusive UTC end. */
  start: string;
  end: string;
}

export function orderDateRange(date: string, timezone: string, now = new Date()): OrderDateRange {
  if (!timezone || /^[+-]/.test(timezone)) throw new Error("An explicit IANA timezone is required");
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone, calendar: "iso8601", numberingSystem: "latn",
      year: "numeric", month: "2-digit", day: "2-digit",
      timeZoneName: "longOffset",
    });
  } catch {
    throw new Error("Invalid IANA timezone");
  }
  const localDate = (instant: number) => {
    const parts = formatter.formatToParts(instant);
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(value => value.type === type)!.value;
    return `${part("year").padStart(4, "0")}-${part("month")}-${part("day")}`;
  };
  if (date === "today") date = localDate(now.getTime());
  const midnight = Date.parse(`${date}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(midnight)
    || date < "1900-01-01" || date > "9998-12-31"
    || new Date(midnight).toISOString().slice(0, 10) !== date) {
    throw new Error("Invalid calendar date; use today or YYYY-MM-DD between 1900 and 9998");
  }
  // IANA transitions can briefly enter a date and then rewind to the previous
  // date (e.g. Casey 2010, Goose Bay 1988). One REST interval cannot represent
  // either split date. Locate offset changes, including sub-hour transitions,
  // before using the monotone calendar-date search below.
  const hourMs = 3600_000;
  const offsetAt = (instant: number) => formatter.formatToParts(instant)
    .find(part => part.type === "timeZoneName")!.value;
  let previousOffset = offsetAt(midnight - 48 * hourMs);
  for (let sample = midnight - 47 * hourMs; sample <= midnight + 48 * hourMs; sample += hourMs) {
    const offset = offsetAt(sample);
    if (offset !== previousOffset) {
      let low = sample - hourMs;
      let high = sample;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (offsetAt(middle) === previousOffset) low = middle + 1;
        else high = middle;
      }
      const before = localDate(high - 1);
      const after = localDate(high);
      if (before > after && (before === date || after === date)) {
        throw new Error("Non-contiguous calendar date cannot be queried as one interval");
      }
    }
    previousOffset = offset;
  }
  // Find the first instant of each local date independently: a day need not be
  // 24 hours, and midnight itself can be skipped or repeated by an offset change.
  const boundary = (target: string, approximate: number) => {
    let low = approximate - 48 * 3600_000;
    let high = approximate + 48 * 3600_000;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (localDate(middle) < target) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  const nextDate = new Date(midnight + 86400_000).toISOString().slice(0, 10);
  const start = boundary(date, midnight);
  if (localDate(start) !== date) throw new Error("Calendar date does not exist in this timezone");
  return {
    date, timezone,
    start: new Date(start).toISOString(),
    end: new Date(boundary(nextDate, midnight + 86400_000)).toISOString(),
  };
}
