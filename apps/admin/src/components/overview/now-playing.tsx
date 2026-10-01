import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import type { NowPlayingEntry } from "@/lib/api";
import { formatClock } from "@/lib/format";
import { estimatePositionMs } from "@/lib/overview";

const STATE_LABELS: Record<NowPlayingEntry["state"], string> = {
  playing: "Playing",
  paused: "Paused",
  starting: "Starting",
};

/**
 * Who is listening to what, from the live route. Between its polls, 30 s
 * apart, a playing session's position moves on here, once a second, from
 * where the server put it (`estimatePositionMs`).
 */
export function NowPlaying({
  entries,
  receivedAt,
}: {
  entries: NowPlayingEntry[] | undefined;
  receivedAt: number;
}) {
  const now = useTicker(entries?.some((entry) => entry.state === "playing") ?? false);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Now playing</CardTitle>
        <CardDescription>
          {entries === undefined || entries.length === 0
            ? "Who is listening in a Subsonic client"
            : `${entries.length} listening`}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {entries === undefined ? (
          <Skeleton className="h-16 w-full" />
        ) : entries.length === 0 ? (
          <Empty className="p-4">
            <EmptyHeader>
              <EmptyTitle>Nobody is listening</EmptyTitle>
              <EmptyDescription>What a Subsonic client plays shows here.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ul className="flex flex-col gap-4">
            {entries.map((entry) => (
              <Listener
                key={`${entry.username}\u0000${entry.playerName}`}
                entry={entry}
                positionMs={estimatePositionMs(entry, receivedAt, now)}
              />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function Listener({ entry, positionMs }: { entry: NowPlayingEntry; positionMs: number }) {
  const durationMs = Math.trunc(entry.track.durationSec * 1_000);
  const position = formatClock(positionMs);
  const duration = formatClock(durationMs);

  return (
    <li className="flex flex-col gap-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate font-medium" title={entry.track.title}>
            {entry.track.title}
          </div>
          <div className="truncate text-sm text-muted-foreground">
            {entry.track.album
              ? `${entry.track.artist} · ${entry.track.album}`
              : entry.track.artist}
          </div>
        </div>
        <Badge variant={entry.state === "playing" ? "default" : "secondary"}>
          {STATE_LABELS[entry.state]}
        </Badge>
      </div>
      <Progress
        value={durationMs > 0 ? Math.min(positionMs, durationMs) : null}
        max={durationMs > 0 ? durationMs : 100}
        aria-label={`${entry.track.title}, ${position} of ${duration}`}
        getAriaValueText={() => `${position} of ${duration}`}
      />
      <div className="flex justify-between gap-2 text-xs text-muted-foreground">
        <span className="truncate">
          {entry.username} on {entry.playerName}
        </span>
        <span className="shrink-0 tabular-nums">
          {position} / {duration}
        </span>
      </div>
    </li>
  );
}

/**
 * This browser's clock, read again every second while `running`, so a
 * playing position moves on between polls; still otherwise.
 */
function useTicker(running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) {
      return;
    }
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [running]);
  return now;
}
