import { formatDateTime, formatRelative } from "@/lib/format";

/**
 * A recent event's time, as the console writes it (#128): how long ago
 * (`5 minutes ago`), from `now`, in a `<time>` that carries the instant
 * itself, with the absolute time as its `title`.
 */
export function RelativeTime({ iso, now }: { iso: string; now: number }) {
  return (
    <time dateTime={iso} title={formatDateTime(iso)}>
      {formatRelative(iso, now)}
    </time>
  );
}
