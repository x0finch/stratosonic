import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { LibraryCounts } from "@/lib/api";
import { formatBytes, formatCount, formatDuration } from "@/lib/format";

const CARDS: { label: string; value: (counts: LibraryCounts) => string }[] = [
  { label: "Artists", value: (counts) => formatCount(counts.artists) },
  { label: "Albums", value: (counts) => formatCount(counts.albums) },
  { label: "Tracks", value: (counts) => formatCount(counts.tracks) },
  { label: "Genres", value: (counts) => formatCount(counts.genres) },
  { label: "Playing time", value: (counts) => formatDuration(counts.durationSec) },
  { label: "Size", value: (counts) => formatBytes(counts.sizeBytes) },
];

/**
 * The library's totals, one card each, as the dashboard-01 block's section
 * cards: a label above a large number. `counts` is absent while loading.
 */
export function LibraryCards({ counts }: { counts: LibraryCounts | undefined }) {
  return (
    <section
      aria-label="Library totals"
      className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6"
    >
      {CARDS.map(({ label, value }) => (
        <Card key={label} size="sm">
          <CardHeader>
            <CardDescription>{label}</CardDescription>
            {counts ? (
              <CardTitle className="text-2xl font-semibold tabular-nums">{value(counts)}</CardTitle>
            ) : (
              <Skeleton className="h-8 w-20" />
            )}
          </CardHeader>
        </Card>
      ))}
    </section>
  );
}
