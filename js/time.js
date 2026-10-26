// Calendar dates for Asia/Kuala_Lumpur. Purchase dates are YYYY-MM-DD strings,
// never parsed as UTC midnight, so the day does not shift across time zones.

export const TZ = 'Asia/Kuala_Lumpur';

let shiftMs = 0;

export function now() {
  return new Date(Date.now() + shiftMs);
}

// Move "now" to an absolute instant. Pass null to follow the real clock again.
export function setNow(value) {
  if (value == null) {
    shiftMs = 0;
    return now();
  }
  const target = value instanceof Date ? value.getTime() : Date.parse(value);
  if (Number.isNaN(target)) throw new Error('Invalid date');
  shiftMs = target - Date.now();
  return now();
}

export function todayStamp(date = now()) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value])
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

export function todayYMD(date = now()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  const value = fmt.format(date);
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const parts = Object.fromEntries(
    fmt.formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value])
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function currentMonth(date = now()) {
  return todayYMD(date).slice(0, 7);
}

export function formatToday(date = now()) {
  return new Intl.DateTimeFormat('en-MY', {
    timeZone: TZ,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  }).format(date);
}

function utcDate(ymd) {
  const [year, month, day] = ymd.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

export function formatMonth(ym) {
  return new Intl.DateTimeFormat('en-MY', {
    timeZone: 'UTC',
    month: 'long',
    year: 'numeric'
  }).format(utcDate(`${ym}-01`));
}

export function formatMonthShort(ym) {
  return new Intl.DateTimeFormat('en-MY', {
    timeZone: 'UTC',
    month: 'short',
    year: 'numeric'
  }).format(utcDate(`${ym}-01`));
}

export function formatDay(ymd) {
  return new Intl.DateTimeFormat('en-MY', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short'
  }).format(utcDate(ymd));
}

export function formatFullDay(ymd) {
  return new Intl.DateTimeFormat('en-MY', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  }).format(utcDate(ymd));
}

export function isYMD(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

export function isMonth(value) {
  return typeof value === 'string' && isYMD(`${value}-01`);
}

export function addMonths(ym, count) {
  const [year, month] = ym.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1 + count, 1));
  const nextMonth = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${date.getUTCFullYear()}-${nextMonth}`;
}

export function daysBetween(startYmd, endYmd) {
  const toUtc = (ymd) => {
    const [year, month, day] = ymd.split('-').map(Number);
    return Date.UTC(year, month - 1, day);
  };
  return Math.round((toUtc(endYmd) - toUtc(startYmd)) / 86400000);
}

export function monthsFrom(startYm, endYm) {
  if (!startYm || !endYm || startYm > endYm) return [];
  const months = [];
  let cursor = startYm;
  while (cursor <= endYm && months.length < 240) {
    months.push(cursor);
    cursor = addMonths(cursor, 1);
  }
  return months;
}
