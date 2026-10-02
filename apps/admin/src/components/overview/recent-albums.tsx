import { RelativeTime } from "@/components/relative-time";
import { Section } from "@/components/section";
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
import { formatCount, MISSING } from "@/lib/format";

/**
 * The twelve albums added last, newest first, as `getAlbumList2?type=newest`
 * lists them: how the owner checks that an upload was indexed. No covers in
 * Phase 1 (#82, "Out of Scope"). The text columns come first and the
 * numbers last (#128), so a right-aligned number never meets a left-aligned
 * text.
 */
export function RecentAlbums({ albums, now }: { albums: RecentAlbum[] | undefined; now: number }) {
  return (
    <Section title="Recently added" description="The albums the scans added last">
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
              <TableHead>Added</TableHead>
              <TableHead className="hidden text-right md:table-cell">Year</TableHead>
              <TableHead className="hidden text-right sm:table-cell">Tracks</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {albums.map((album) => (
              <TableRow key={album.id}>
                <TableCell className="max-w-44 align-top whitespace-normal sm:max-w-64">
                  <div className="truncate font-medium" title={album.name}>
                    {album.name}
                  </div>
                  <div className="truncate text-muted-foreground" title={album.artist}>
                    {album.artist}
                  </div>
                </TableCell>
                <TableCell className="align-top text-muted-foreground">
                  <RelativeTime iso={album.createdAt} now={now} />
                </TableCell>
                <TableCell className="hidden text-right align-top tabular-nums md:table-cell">
                  {album.year ?? MISSING}
                </TableCell>
                <TableCell className="hidden text-right align-top tabular-nums sm:table-cell">
                  {formatCount(album.songCount)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Section>
  );
}
