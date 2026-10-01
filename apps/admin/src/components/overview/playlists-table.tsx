import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import { formatCount, formatDateTime, formatDuration, formatRelative } from "@/lib/format";

/**
 * Every playlist, by name, with the Subsonic user it belongs to and its
 * track count. A playlist whose owner is gone says so.
 */
export function PlaylistsTable({
  playlists,
  now,
}: {
  playlists: PlaylistSummary[] | undefined;
  now: number;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Playlists</CardTitle>
        <CardDescription>
          {playlists === undefined || playlists.length === 0
            ? "Every user's playlists"
            : `${formatCount(playlists.length)} playlist${playlists.length === 1 ? "" : "s"}, every user's`}
        </CardDescription>
      </CardHeader>
      <CardContent>
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
                <TableHead>Owner</TableHead>
                <TableHead className="text-right">Tracks</TableHead>
                <TableHead className="hidden text-right sm:table-cell">Length</TableHead>
                <TableHead className="hidden text-right md:table-cell">Changed</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {playlists.map((playlist) => (
                <TableRow key={playlist.id}>
                  <TableCell className="max-w-40 sm:max-w-80">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium" title={playlist.name}>
                        {playlist.name}
                      </span>
                      {playlist.public ? <Badge variant="secondary">Public</Badge> : null}
                    </div>
                  </TableCell>
                  <TableCell className={playlist.owner === null ? "text-muted-foreground" : ""}>
                    {playlist.owner ?? "No owner"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatCount(playlist.songCount)}
                  </TableCell>
                  <TableCell className="hidden text-right tabular-nums sm:table-cell">
                    {formatDuration(playlist.durationSec)}
                  </TableCell>
                  <TableCell
                    className="hidden text-right text-muted-foreground md:table-cell"
                    title={formatDateTime(playlist.changedAt)}
                  >
                    {formatRelative(playlist.changedAt, now)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
