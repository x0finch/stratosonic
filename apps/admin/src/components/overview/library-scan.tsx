import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ScanSearchIcon } from "lucide-react";
import type { ReactNode } from "react";

import { RelativeTime } from "@/components/relative-time";
import { Section } from "@/components/section";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress, ProgressLabel, ProgressValue } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { requestScan, type ScanStatus } from "@/lib/api";
import { formatCount, formatDuration } from "@/lib/format";
import {
  afterScanRequest,
  describePause,
  describeScanLibrary,
  describeSchedule,
  type LiveRead,
} from "@/lib/overview";
import { toastError, toastSuccess } from "@/lib/toasts";

/**
 * The scan: whether a pass is in flight and how far it has got, the last
 * completed pass, and **Scan now** for a role that may start one. Each fact
 * is said once (#128): the description says when the last pass finished
 * and how long it took, and its counts sit below.
 *
 * The bar is determinate while the last pass's track count is known, the
 * best denominator there is: R2's listing gives no total (#82). Before any
 * pass, between the poke and the first step, and while playlists import,
 * it is indeterminate, with a spinner beside its label.
 *
 * `clock` is the live read the scan came with: its `serverTime` and when it
 * arrived, from which a scheduled pass's time left is counted. `skipped`
 * says which libraries the last pass skipped, where more than one library
 * exists (lib/overview.ts, `describeSkipped`).
 */
export function LibraryScan({
  scan,
  clock,
  canScan,
  now,
  skipped = [],
}: {
  scan: ScanStatus | undefined;
  clock: Pick<LiveRead, "serverTime" | "receivedAt"> | undefined;
  canScan: boolean;
  now: number;
  skipped?: readonly string[];
}) {
  return (
    <Section
      title="Library scan"
      description={
        scan ? describeScan(scan, clock ?? browserClock(now), now) : "Reading the scan's state…"
      }
      action={canScan ? <ScanNowButton /> : null}
    >
      {scan === undefined ? (
        <Skeleton className="h-16 w-full" />
      ) : scan.running ? (
        <ScanProgress scan={scan} />
      ) : (
        <LastPass scan={scan} canScan={canScan} skipped={skipped} />
      )}
    </Section>
  );
}

/**
 * What the scan is doing next, in one sentence. A pass the server will run
 * for recent file changes (`describeSchedule`) takes the place of the last
 * pass's finish, as a running pass does: while a pass runs it says another
 * follows, and while idle when one starts. The last pass's counts stay below.
 *
 * Across libraries (#84): a running pass says which library it is in
 * ("Scanning Archive (2 of 3)."), and a pass stopped by the daily write
 * budget says so and when it resumes.
 */
function describeScan(
  scan: ScanStatus,
  clock: Pick<LiveRead, "serverTime" | "receivedAt">,
  now: number,
): ReactNode {
  const paused = describePause(scan.paused, now);
  if (paused !== null) {
    return paused;
  }
  const scheduled = describeSchedule(scan, clock, now);
  if (scan.running) {
    const where = describeScanLibrary(scan);
    if (scheduled !== null && scan.scheduled?.afterCurrentPass) {
      return where === null ? scheduled : `${where} Another follows it for recent file changes.`;
    }
    if (scan.phase === "playlists") {
      return "Importing playlists";
    }
    return where ?? "A scan is running.";
  }
  if (scheduled !== null) {
    return scheduled;
  }
  if (scan.last) {
    return (
      <>
        Last scan finished <RelativeTime iso={scan.last.finishedAt} now={now} /> and took{" "}
        {formatDuration(passSeconds(scan.last))}.
      </>
    );
  }
  return "No scan has finished yet.";
}

/** This browser's clock as a live read's, for a scan that came with none. */
function browserClock(now: number): Pick<LiveRead, "serverTime" | "receivedAt"> {
  return { serverTime: new Date(now).toISOString(), receivedAt: now };
}

/** How long a pass took, in seconds. */
function passSeconds(pass: NonNullable<ScanStatus["last"]>): number {
  return (Date.parse(pass.finishedAt) - Date.parse(pass.startedAt)) / 1_000;
}

function ScanNowButton() {
  const queryClient = useQueryClient();
  const scan = useMutation({
    mutationFn: requestScan,
    onSuccess: (result) => {
      afterScanRequest(queryClient, result);
      if (result.outcome === "started") {
        toastSuccess("Scan started", "This page follows it as it goes.");
      } else {
        toastSuccess("A scan is already running", "This page follows it as it goes.");
      }
    },
    onError: (error) => toastError(error, "The scan could not start"),
  });

  return (
    <Button variant="outline" size="sm" disabled={scan.isPending} onClick={() => scan.mutate()}>
      <ScanSearchIcon data-icon="inline-start" />
      Scan now
    </Button>
  );
}

function ScanProgress({ scan }: { scan: ScanStatus }) {
  const { progress, estimatedTotal } = scan;
  const tracks = progress?.tracks ?? 0;
  const determinate = progress !== null && estimatedTotal !== null && estimatedTotal > 0;
  const label =
    scan.phase === "playlists" ? "Importing playlists" : progress ? "Tracks" : "Starting";
  const text = determinate
    ? tracks < estimatedTotal
      ? `${formatCount(tracks)} of about ${formatCount(estimatedTotal)}`
      : `${formatCount(tracks)}`
    : progress
      ? `${formatCount(tracks)} so far`
      : "";

  return (
    <div className="flex flex-col gap-3">
      <Progress
        value={determinate ? Math.min(tracks, estimatedTotal) : null}
        max={determinate ? estimatedTotal : 100}
        getAriaValueText={() => text || label}
      >
        {/* An indeterminate bar has nothing to fill, so the spinner shows the
            pass at work. The bar already says so to assistive technology. */}
        {determinate ? null : <Spinner aria-hidden="true" />}
        <ProgressLabel>{label}</ProgressLabel>
        <ProgressValue>{() => text}</ProgressValue>
      </Progress>
      {progress ? (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
          <Stat label="Examined" value={progress.examined} />
          <Stat label="Added" value={progress.added} />
          <Stat label="Updated" value={progress.updated} />
          <Stat label="Removed" value={progress.removed} />
        </dl>
      ) : null}
    </div>
  );
}

/**
 * The last completed pass's counts, under the description that says when
 * it finished and how long it took, and beneath them each library the pass
 * skipped, and why (#84). While a pass runs, its progress takes their place.
 */
function LastPass({
  scan,
  canScan,
  skipped,
}: {
  scan: ScanStatus;
  canScan: boolean;
  skipped: readonly string[];
}) {
  const { last } = scan;
  const skips = skipped.map((line) => (
    <p key={line} className="text-sm text-muted-foreground">
      {line}
    </p>
  ));
  if (last === null) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">
          The library is scanned on a schedule.
          {canScan ? " Scan now to index an upload at once." : null}
        </p>
        {skips}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
        <Stat label="Tracks" value={last.counts.indexed + last.counts.unchanged} />
        <Stat label="Added" value={last.counts.added} />
        <Stat label="Updated" value={last.counts.updated} />
        <Stat label="Removed" value={last.counts.removed} />
      </dl>
      {last.counts.broken > 0 ? (
        <div className="flex">
          <Badge variant="destructive">{formatCount(last.counts.broken)} unreadable</Badge>
        </div>
      ) : null}
      {skips}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-baseline justify-between gap-2 sm:flex-col sm:items-start sm:gap-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium tabular-nums">{formatCount(value)}</dd>
    </div>
  );
}
