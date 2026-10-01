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
import type { RecentAlbum } from "@/lib/api";
import { formatCount, formatDateTime, formatRelative } from "@/lib/format";

/**
 * The twelve albums added last, newest first, as `getAlbumList2?type=newest`
 * lists them: how the owner checks that an upload was indexed. No covers in
 * Phase 1 (#82, "Out of Scope").
 */
export function RecentAlbums({ albums, now }: { albums: RecentAlbum[] | undefined; now: number }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Recently added</CardTitle>
        <CardDescription>The albums the scans added last</CardDescription>
      </CardHeader>
      <CardContent>
        {albums === undefined ? (
          <Skeleton className="h-64 w-full" />
        ) : albums.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No albums yet</EmptyTitle>
              <EmptyDescription>Albums appear here once a scan has indexed them.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Album</TableHead>
                <TableHead className="hidden sm:table-cell">Year</TableHead>
                <TableHead className="text-right">Tracks</TableHead>
                <TableHead className="text-right">Added</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {albums.map((album) => (
                <TableRow key={album.id}>
                  <TableCell className="max-w-48 whitespace-normal sm:max-w-64">
                    <div className="truncate font-medium" title={album.name}>
                      {album.name}
                    </div>
                    <div className="truncate text-muted-foreground" title={album.artist}>
                      {album.artist}
                    </div>
                  </TableCell>
                  <TableCell className="hidden tabular-nums sm:table-cell">
                    {album.year ?? "–"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatCount(album.songCount)}
                  </TableCell>
                  <TableCell
                    className="text-right text-muted-foreground"
                    title={formatDateTime(album.createdAt)}
                  >
                    {formatRelative(album.createdAt, now)}
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
