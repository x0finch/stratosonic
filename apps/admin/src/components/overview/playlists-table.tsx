import { cn } from "cn";

import { RelativeTime } from "@/components/relative-time";
import { Section } from "@/components/section";
import { Badge } from "@/components/ui/badge";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { PlaylistSummary } from "@/lib/api";
import { formatCount, formatLength } from "@/lib/format";

/**
 * Every playlist, by name, with the Subsonic user it belongs to and its
 * track count. A playlist whose owner is gone says so. The text columns
 * come first and the numbers last (#128). A name is never truncated: it
 * wraps, even one with no spaces, and on a narrow table the secondary
 * columns give way, the owner first. How narrow is the table's own width (a
 * container query), not the screen's, which the sidebar shares.
 */
export function PlaylistsTable({
  playlists,
  now,
}: {
  playlists: PlaylistSummary[] | undefined;
  now: number;
}) {
  return (
    <Section
      title="Playlists"
      description={
        playlists === undefined || playlists.length === 0
          ? "Every user's playlists"
          : `${formatCount(playlists.length)} playlist${playlists.length === 1 ? "" : "s"}, every user's`
      }
    >
      {playlists === undefined ? (
        <Skeleton className="h-32 w-full" />
      ) : playlists.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No playlists</EmptyTitle>
            <EmptyDescription>
              Playlists appear here once a scan imports an .m3u file or a client saves one.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="@container">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead className="hidden @2xl:table-cell">Owner</TableHead>
                <TableHead className="hidden @lg:table-cell">Changed</TableHead>
                <TableHead className="text-right">Tracks</TableHead>
                <TableHead className="hidden text-right @lg:table-cell">Length</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {playlists.map((playlist) => (
                <TableRow key={playlist.id}>
                  {/* `wrap-anywhere`, not `wrap-break-word`: only `anywhere`
                    lowers the cell's min-content width, which an auto-layout
                    table sizes its columns by, so a name with no spaces
                    breaks rather than widening the table. */}
                  <TableCell className="whitespace-normal wrap-anywhere">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="font-medium">{playlist.name}</span>
                      {playlist.public ? <Badge variant="secondary">Public</Badge> : null}
                    </div>
                  </TableCell>
                  <TableCell
                    className={cn(
                      "hidden @2xl:table-cell",
                      playlist.owner === null && "text-muted-foreground",
                    )}
                  >
                    {playlist.owner ?? "No owner"}
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground @lg:table-cell">
                    <RelativeTime iso={playlist.changedAt} now={now} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatCount(playlist.songCount)}
                  </TableCell>
                  <TableCell className="hidden text-right tabular-nums @lg:table-cell">
                    {formatLength(playlist.durationSec)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </Section>
  );
}
