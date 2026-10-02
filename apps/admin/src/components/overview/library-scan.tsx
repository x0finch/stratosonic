import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ScanSearchIcon } from "lucide-react";

import { Section } from "@/components/section";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress, ProgressLabel, ProgressValue } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { requestScan, type ScanStatus } from "@/lib/api";
import { formatCount, formatDateTime, formatDuration, formatRelative } from "@/lib/format";
import { afterScanRequest } from "@/lib/overview";
import { toastError, toastSuccess } from "@/lib/toasts";

/**
 * The scan: whether a pass is in flight and how far it has got, the last
 * completed pass, and **Scan now** for a role that may start one.
 *
 * The bar is determinate while the last pass's track count is known, the
 * best denominator there is: R2's listing gives no total (#82). Before any
 * pass, between the poke and the first step, and while playlists import,
 * it is indeterminate, with a spinner beside its label.
 */
export function LibraryScan({
  scan,
  canScan,
  now,
}: {
  scan: ScanStatus | undefined;
  canScan: boolean;
  now: number;
}) {
  return (
    <Section
      title="Library scan"
      description={scan ? describeScan(scan, now) : "Reading the scan's state…"}
      action={canScan ? <ScanNowButton /> : null}
    >
      {scan === undefined ? (
        <Skeleton className="h-16 w-full" />
      ) : (
        <>
          {scan.running ? <ScanProgress scan={scan} /> : null}
          <LastPass scan={scan} canScan={canScan} now={now} />
        </>
      )}
    </Section>
  );
}

function describeScan(scan: ScanStatus, now: number): string {
  if (scan.running) {
    return scan.phase === "playlists" ? "Importing playlists" : "A scan is running.";
  }
  if (scan.last) {
    return `Last scan finished ${formatRelative(scan.last.finishedAt, now)}.`;
  }
  return "No scan has finished yet.";
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

function LastPass({ scan, canScan, now }: { scan: ScanStatus; canScan: boolean; now: number }) {
  const { last } = scan;
  if (last === null) {
    return scan.running ? null : (
      <p className="text-sm text-muted-foreground">
        The library is scanned on a schedule.
        {canScan ? " Scan now to index an upload at once." : null}
      </p>
    );
  }
  const took = (Date.parse(last.finishedAt) - Date.parse(last.startedAt)) / 1_000;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">Last pass</span>
        <span className="text-muted-foreground" title={formatDateTime(last.finishedAt)}>
          {formatRelative(last.finishedAt, now)}, in {formatDuration(took)}
        </span>
        {last.counts.broken > 0 ? (
          <Badge variant="destructive">{formatCount(last.counts.broken)} unreadable</Badge>
        ) : null}
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
        <Stat label="Tracks" value={last.counts.indexed + last.counts.unchanged} />
        <Stat label="Added" value={last.counts.added} />
        <Stat label="Updated" value={last.counts.updated} />
        <Stat label="Removed" value={last.counts.removed} />
      </dl>
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
