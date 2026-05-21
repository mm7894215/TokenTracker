export function getBrowserTimeZone() {
  if (typeof Intl === "undefined" || !Intl.DateTimeFormat) return null;
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return tz || null;
  } catch (_e) {
    return null;
  }
}

export function getBrowserTimeZoneOffsetMinutes(date: any = new Date()) {
  const dt = date instanceof Date ? date : new Date(date);
  if (!Number.isFinite(dt.getTime())) return 0;
  const offset = dt.getTimezoneOffset();
  if (!Number.isFinite(offset)) return 0;
  return -offset;
}

type TimeZoneOptions = {
  timeZone?: string;
  offsetMinutes?: number;
  date?: Date;
};

function formatUtcOffset(offsetMinutes: any) {
  if (!Number.isFinite(offsetMinutes) || offsetMinutes === 0) return "UTC";
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `UTC${sign}${hh}:${mm}`;
}

export function formatTimeZoneLabel({ timeZone, offsetMinutes }: TimeZoneOptions = {}) {
  const offsetLabel = formatUtcOffset(offsetMinutes);
  if (timeZone && timeZone !== "UTC") return `${timeZone} (${offsetLabel})`;
  return offsetLabel;
}

export function formatTimeZoneShortLabel({ timeZone, offsetMinutes }: TimeZoneOptions = {}) {
  if (Number.isFinite(offsetMinutes)) return formatUtcOffset(offsetMinutes);
  if (timeZone) return timeZone;
  return "UTC";
}

export function getLocalDayKey({
  timeZone,
  offsetMinutes,
  date = new Date(),
}: TimeZoneOptions = {}) {
  const dt = date instanceof Date ? date : new Date(date);
  if (!Number.isFinite(dt.getTime())) return "";

  if (timeZone && typeof Intl !== "undefined" && Intl.DateTimeFormat) {
    try {
      const formatter = new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      });
      const parts = formatter.formatToParts(dt);
      const values = parts.reduce(
        (acc: Record<string, string>, part) => {
          if (part.type && part.value) acc[part.type] = part.value;
          return acc;
        },
        {} as Record<string, string>,
      );
      const year = values.year;
      const month = values.month;
      const day = values.day;
      if (year && month && day) return `${year}-${month}-${day}`;
    } catch (_e) {
      // fallback below
    }
  }

  if (typeof offsetMinutes === "number" && Number.isFinite(offsetMinutes)) {
    const shifted = new Date(dt.getTime() + offsetMinutes * 60000);
    return formatUtcDateKey(shifted);
  }

  return formatLocalDateKey(dt);
}

export function getLocalDateParts({
  timeZone,
  offsetMinutes,
  date = new Date(),
}: TimeZoneOptions = {}) {
  const dt = date instanceof Date ? date : new Date(date);
  if (!Number.isFinite(dt.getTime())) return null;

  if (timeZone && typeof Intl !== "undefined" && Intl.DateTimeFormat) {
    try {
      const formatter = new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      });
      const parts = formatter.formatToParts(dt);
      const values = parts.reduce(
        (acc: Record<string, string>, part) => {
          if (part.type && part.value) acc[part.type] = part.value;
          return acc;
        },
        {} as Record<string, string>,
      );
      const year = Number(values.year);
      const month = Number(values.month);
      const day = Number(values.day);
      if (Number.isFinite(year) && Number.isFinite(month) && Number.isFinite(day)) {
        return { year, month, day };
      }
    } catch (_e) {
      // fallback below
    }
  }

  if (typeof offsetMinutes === "number" && Number.isFinite(offsetMinutes)) {
    const shifted = new Date(dt.getTime() + offsetMinutes * 60000);
    return {
      year: shifted.getUTCFullYear(),
      month: shifted.getUTCMonth() + 1,
      day: shifted.getUTCDate(),
    };
  }

  return { year: dt.getFullYear(), month: dt.getMonth() + 1, day: dt.getDate() };
}

export function getTimeZoneCacheKey({ timeZone, offsetMinutes }: TimeZoneOptions = {}) {
  if (timeZone) return `tz:${timeZone}`;
  if (typeof offsetMinutes === "number" && Number.isFinite(offsetMinutes)) {
    return `offset:${Math.trunc(offsetMinutes)}`;
  }
  return "utc";
}

function formatUtcDateKey(date: Date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function formatLocalDateKey(date: Date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
