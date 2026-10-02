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
 * wraps, and on a narrow screen the secondary columns give way, the owner
 * first.
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
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead className="hidden md:table-cell">Owner</TableHead>
              <TableHead className="hidden sm:table-cell">Changed</TableHead>
              <TableHead className="text-right">Tracks</TableHead>
              <TableHead className="hidden text-right sm:table-cell">Length</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {playlists.map((playlist) => (
              <TableRow key={playlist.id}>
                <TableCell className="whitespace-normal">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="font-medium">{playlist.name}</span>
                    {playlist.public ? <Badge variant="secondary">Public</Badge> : null}
                  </div>
                </TableCell>
                <TableCell
                  className={cn(
                    "hidden md:table-cell",
                    playlist.owner === null && "text-muted-foreground",
                  )}
                >
                  {playlist.owner ?? "No owner"}
                </TableCell>
                <TableCell className="hidden text-muted-foreground sm:table-cell">
                  <RelativeTime iso={playlist.changedAt} now={now} />
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatCount(playlist.songCount)}
                </TableCell>
                <TableCell className="hidden text-right tabular-nums sm:table-cell">
                  {formatLength(playlist.durationSec)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Section>
  );
}
