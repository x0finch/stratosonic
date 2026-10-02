import { Skeleton } from "@/components/ui/skeleton";
import type { LibraryCounts } from "@/lib/api";
import { formatBytes, formatCount, formatDuration } from "@/lib/format";

const TOTALS: { label: string; value: (counts: LibraryCounts) => string }[] = [
  { label: "Artists", value: (counts) => formatCount(counts.artists) },
  { label: "Albums", value: (counts) => formatCount(counts.albums) },
  { label: "Tracks", value: (counts) => formatCount(counts.tracks) },
  { label: "Genres", value: (counts) => formatCount(counts.genres) },
  { label: "Playing time", value: (counts) => formatDuration(counts.durationSec) },
  { label: "Size", value: (counts) => formatBytes(counts.sizeBytes) },
];

/**
 * The library's totals, in one row of stats: a label above a large number,
 * with a thin divider between each and the next, and no border of their own
 * (#125). The row wraps to three columns, then two, on a narrower screen,
 * and the dividers follow: each stat has a border above and to its left,
 * and the grid sits one border up and one gutter left inside a box that
 * clips them, so only the borders between stats show, and the first column
 * lines up with the sections below. `counts` is absent while loading.
 */
export function LibraryTotals({ counts }: { counts: LibraryCounts | undefined }) {
  return (
    <section aria-label="Library totals" className="overflow-hidden">
      <dl className="-mt-px -ml-4 grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6">
        {TOTALS.map(({ label, value }) => (
          <div key={label} className="flex min-w-0 flex-col gap-1 border-t border-l px-4 py-3">
            <dt className="text-sm text-muted-foreground">{label}</dt>
            <dd className="text-2xl font-semibold tabular-nums">
              {counts ? value(counts) : <Skeleton className="h-8 w-20" />}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
