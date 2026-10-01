/**
 * How the Overview writes its numbers. Everything is in English, as the rest
 * of the console is, with the browser's time zone for dates.
 */

const COUNT = new Intl.NumberFormat("en");

/** A count, grouped: `5,012`. */
export function formatCount(value: number): string {
  return COUNT.format(value);
}

/**
 * A length of time in the largest two units that matter: `3 d 4 h`,
 * `2 h 5 min`, `41 min`, `12 s`.
 */
export function formatDuration(seconds: number): string {
  const total = Math.max(Math.round(seconds), 0);
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  if (days > 0) {
    return hours > 0 ? `${formatCount(days)} d ${hours} h` : `${formatCount(days)} d`;
  }
  if (hours > 0) {
    return minutes > 0 ? `${hours} h ${minutes} min` : `${hours} h`;
  }
  if (minutes > 0) {
    return `${minutes} min`;
  }
  return `${total} s`;
}

/** A track position or length as a player shows it: `4:01`, `1:02:03`. */
export function formatClock(milliseconds: number): string {
  const total = Math.max(Math.floor(milliseconds / 1_000), 0);
  const hours = Math.floor(total / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
    : `${minutes}:${seconds}`;
}

const BYTE_UNITS = ["B", "kB", "MB", "GB", "TB", "PB"];

/**
 * A size in decimal units, as Cloudflare states its limits (10 GB of R2
 * storage is 10,000,000,000 bytes): `98.8 GB`.
 */
export function formatBytes(bytes: number): string {
  let value = Math.max(bytes, 0);
  let unit = 0;
  while (value >= 1_000 && unit < BYTE_UNITS.length - 1) {
    value /= 1_000;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${BYTE_UNITS[unit]}`;
}

/** A share of a limit, as a whole percentage, or with a decimal below 10 %. */
export function formatPercent(value: number, limit: number): string {
  if (limit <= 0) {
    return "–";
  }
  const percent = (value / limit) * 100;
  return `${percent < 10 ? percent.toFixed(1) : Math.round(percent)}%`;
}

const RELATIVE = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

const RELATIVE_STEPS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["second", 60],
  ["minute", 60],
  ["hour", 24],
  ["day", 30],
  ["month", 12],
  ["year", Number.POSITIVE_INFINITY],
];

/** How long ago an instant was, from `now`: `5 minutes ago`, `yesterday`. */
export function formatRelative(iso: string, now: number): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) {
    return "";
  }
  let value = Math.round((at - now) / 1_000);
  for (const [unit, size] of RELATIVE_STEPS) {
    if (Math.abs(value) < size) {
      return value === 0 && unit === "second" ? "just now" : RELATIVE.format(value, unit);
    }
    value = Math.round(value / size);
  }
  return "";
}

const DATE_TIME = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" });

/** An instant in full, for a tooltip or title: `Oct 1, 2026, 12:00 PM`. */
export function formatDateTime(iso: string): string {
  const at = Date.parse(iso);
  return Number.isFinite(at) ? DATE_TIME.format(at) : "";
}
