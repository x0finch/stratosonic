import { CircleAlertIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { RelativeTime } from "@/components/relative-time";
import { Section } from "@/components/section";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Progress, ProgressLabel, ProgressValue } from "@/components/ui/progress";
import { useClock } from "@/hooks/use-clock";
import type { FilesConfig } from "@/lib/api";
import { countOf, LISTED_NAMES } from "@/lib/files";
import { formatBytes, formatCount } from "@/lib/format";
import {
  describeFailure,
  describeQueue,
  percentOf,
  type UploadQueue,
  type UploadView,
} from "@/lib/uploads";

/**
 * The Uploads section (#83, "Layout", item 6), while the queue holds a file:
 * "4 of 12 uploaded", then one row a file, its key in mono over a `Progress`
 * whose label is its state ("Waiting", "Uploading" with its percent,
 * "Uploaded", "Already exists" with **Replace** and **Skip**, or "Failed:"
 * and why, in `destructive` with an icon). A file still to go has a cancel
 * button. Several conflicts get **Replace all**, which asks first, and
 * **Skip all**.
 */
export function UploadsSection({
  items,
  queue,
  allowed,
}: {
  items: readonly UploadView[];
  queue: UploadQueue;
  allowed: FilesConfig["allowed"] | undefined;
}) {
  const now = useClock();
  const [confirming, setConfirming] = useState(false);
  const conflicts = items.filter((item) => item.state === "exists");
  const finished = items.some((item) =>
    ["uploaded", "failed", "skipped", "canceled"].includes(item.state),
  );
  const running = items.some((item) => ["waiting", "signing", "uploading"].includes(item.state));

  return (
    <Section
      title="Uploads"
      description={describeQueue(items)}
      action={
        <>
          {running ? (
            <Button variant="outline" size="sm" onClick={() => queue.cancelAll()}>
              Cancel all
            </Button>
          ) : null}
          {finished ? (
            <Button variant="outline" size="sm" onClick={() => queue.clearFinished()}>
              Clear finished
            </Button>
          ) : null}
        </>
      }
    >
      {conflicts.length > 1 ? (
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <p className="min-w-0 text-muted-foreground">
            {countOf(conflicts.length, "file")} already exist. Replace them, or skip them.
          </p>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setConfirming(true)}>
              Replace all
            </Button>
            <Button variant="outline" size="sm" onClick={() => queue.skipAll()}>
              Skip all
            </Button>
          </div>
        </div>
      ) : null}
      <ul className="flex flex-col gap-4">
        {items.map((item) => (
          <UploadRow key={item.id} item={item} queue={queue} allowed={allowed} now={now} />
        ))}
      </ul>
      <ReplaceAllDialog
        conflicts={conflicts}
        open={confirming && conflicts.length > 0}
        onOpenChange={setConfirming}
        onConfirm={() => {
          queue.replaceAll();
          setConfirming(false);
        }}
      />
    </Section>
  );
}

/** A row's state, as its `ProgressLabel` says it. */
function stateLabel(item: UploadView): string {
  switch (item.state) {
    case "waiting":
      return "Waiting";
    case "signing":
    case "uploading":
      return "Uploading";
    case "uploaded":
      return "Uploaded";
    case "exists":
      return "Already exists";
    case "failed":
      return "Failed";
    case "skipped":
      return "Skipped";
    case "canceled":
      return "Canceled";
  }
}

function UploadRow({
  item,
  queue,
  allowed,
  now,
}: {
  item: UploadView;
  queue: UploadQueue;
  allowed: FilesConfig["allowed"] | undefined;
  now: number;
}) {
  const active = item.state === "waiting" || item.state === "signing" || item.state === "uploading";
  const sending = item.state === "signing" || item.state === "uploading";
  const failed = item.state === "failed" && item.failure !== undefined;
  const percent = item.state === "uploaded" ? 100 : sending ? percentOf(item) : 0;

  return (
    <li className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <span className="min-w-0 font-mono wrap-anywhere">{item.key}</span>
        {active ? (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Cancel upload"
            onClick={() => queue.cancel(item.id)}
          >
            <XIcon />
          </Button>
        ) : item.state === "exists" ? (
          <div className="flex shrink-0 items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => queue.replace(item.id)}>
              Replace
            </Button>
            <Button variant="outline" size="sm" onClick={() => queue.skip(item.id)}>
              Skip
            </Button>
          </div>
        ) : null}
      </div>
      <Progress value={percent}>
        <ProgressLabel
          className={failed ? "flex min-w-0 items-start gap-1.5 text-destructive" : "min-w-0"}
        >
          {failed && item.failure ? (
            <>
              <CircleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <span className="min-w-0">
                Failed: {describeFailure(item.failure, item.key, allowed)}
              </span>
            </>
          ) : (
            stateLabel(item)
          )}
          {item.state === "exists" && item.existing ? (
            <span className="font-normal text-muted-foreground">
              {" "}
              ({formatBytes(item.existing.size)}, uploaded{" "}
              <RelativeTime iso={item.existing.uploadedAt} now={now} />)
            </span>
          ) : null}
          {/* The bar's name says which file it is. */}
          <span className="sr-only">, {item.key}</span>
        </ProgressLabel>
        {sending || item.state === "uploaded" ? <ProgressValue /> : null}
      </Progress>
    </li>
  );
}

/**
 * Replace all (#83, "Overwrite and conflicts"): confirmed in an alert
 * dialog, since the old files are lost. Each file is signed again with
 * `overwrite: true`, which keeps a track's id and its stars, ratings and
 * play counts (ADR-0002).
 */
function ReplaceAllDialog({
  conflicts,
  open,
  onOpenChange,
  onConfirm,
}: {
  conflicts: readonly UploadView[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  const listed = conflicts.slice(0, LISTED_NAMES);
  const more = conflicts.length - listed.length;

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Replace {countOf(conflicts.length, "file")}?</AlertDialogTitle>
          <AlertDialogDescription render={<div />} className="flex flex-col gap-3">
            <ul className="flex flex-col gap-1">
              {listed.map((item) => (
                <li key={item.id} className="font-mono wrap-anywhere text-foreground">
                  {item.key}
                </li>
              ))}
              {more > 0 ? <li>and {formatCount(more)} more</li> : null}
            </ul>
            <p>
              The old files are lost. A replaced track keeps its stars, ratings and play counts.
            </p>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onConfirm}>
            Replace all
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
