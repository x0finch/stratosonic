import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { LayoutDashboardIcon } from "lucide-react";
import { useState } from "react";

import { ErrorAlert } from "@/components/error-alert";
import { GenreChart } from "@/components/overview/genre-chart";
import { LibraryCards } from "@/components/overview/library-cards";
import { NowPlaying } from "@/components/overview/now-playing";
import { PlaylistsTable } from "@/components/overview/playlists-table";
import { RecentAlbums } from "@/components/overview/recent-albums";
import { ScanCard } from "@/components/overview/scan-card";
import { UsagePanel } from "@/components/overview/usage-panel";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { meQuery } from "@/lib/api";
import { libraryQuery, liveQuery, usageQuery } from "@/lib/overview";
import { can } from "@/lib/roles";

export const Route = createFileRoute("/_shell/")({
  component: Overview,
  staticData: { title: "Overview" },
});

/**
 * The Overview (#82): the library's totals and genres, the scan, who is
 * listening, the free-tier usage, the albums added last and the playlists.
 * Each panel needs its permission, and a role without it gets neither the
 * panel nor its requests; the routes check for themselves. How often each
 * part is read, and that a hidden tab reads nothing, is lib/overview.ts.
 */
function Overview() {
  const { data: me } = useQuery(meQuery);
  const canReadLibrary = can(me, "library:read");
  const canReadActivity = can(me, "activity:read");
  const canReadUsage = can(me, "usage:read");

  const library = useQuery({ ...libraryQuery, enabled: canReadLibrary });
  const live = useQuery({ ...liveQuery, enabled: canReadLibrary });
  const usage = useQuery({ ...usageQuery, enabled: canReadUsage });

  // What "5 minutes ago" is measured from: the latest read, which moves on
  // with every poll, or the page's first render before any.
  const [openedAt] = useState(() => Date.now());
  const now = Math.max(openedAt, live.dataUpdatedAt, library.dataUpdatedAt, usage.dataUpdatedAt);

  // No panel at all before the server says there is a token, and none
  // after it says there is not: an unconfigured server shows no error.
  const configuredUsage = usage.data?.configured ? usage.data : undefined;
  const showUsage = canReadUsage && (configuredUsage !== undefined || usage.isError);
  const nowPlaying = live.data?.nowPlaying;
  const showNowPlaying = canReadActivity && canReadLibrary && nowPlaying !== null;

  if (!canReadLibrary && !canReadUsage) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <LayoutDashboardIcon />
          </EmptyMedia>
          <EmptyTitle>Nothing to show</EmptyTitle>
          <EmptyDescription>
            Your role does not let you see the library or its usage.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <>
      {canReadLibrary ? (
        <>
          {library.isError ? <ErrorAlert error={library.error} /> : null}
          <LibraryCards counts={library.data?.counts} />
          {live.isError ? <ErrorAlert error={live.error} /> : null}
          <div className={showNowPlaying ? "grid gap-4 lg:grid-cols-2" : "grid gap-4"}>
            <ScanCard scan={live.data?.scan} canScan={can(me, "library:scan")} now={now} />
            {showNowPlaying ? (
              <NowPlaying entries={nowPlaying} receivedAt={live.data?.receivedAt ?? now} />
            ) : null}
          </div>
        </>
      ) : null}
      {showUsage ? <UsagePanel usage={configuredUsage} error={usage.error} now={now} /> : null}
      {canReadLibrary ? (
        <>
          <div className="grid gap-4 xl:grid-cols-2">
            <GenreChart genres={library.data?.genres} />
            <RecentAlbums albums={library.data?.recentAlbums} now={now} />
          </div>
          <PlaylistsTable playlists={library.data?.playlists} now={now} />
        </>
      ) : null}
    </>
  );
}
