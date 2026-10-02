import { CircleAlertIcon, XIcon } from "lucide-react";
import { memo, useCallback, useEffect, useRef, useState } from "react";

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
import { useUploads } from "@/hooks/use-upload-queue";
import type { FilesConfig } from "@/lib/api";
import { countOf, LISTED_NAMES } from "@/lib/files";
import { formatBytes, formatCount } from "@/lib/format";
import {
  describeFailure,
  describeHidden,
  describeQueue,
  percentOf,
  shownRows,
  type UploadQueue,
  type UploadView,
} from "@/lib/uploads";

/** What a row's own buttons do. */
type RowAction = "replace" | "skip" | "cancel";

/** Where focus goes once the row it was on loses its buttons: a row, or the heading. */
type FocusTarget = number | "heading" | null;

/** Whether a row has buttons: Replace and Skip, or Cancel upload. */
function actionable(item: UploadView): boolean {
  return (
    item.state === "exists" ||
    item.state === "waiting" ||
    item.state === "signing" ||
    item.state === "uploading"
  );
}

/**
 * The Uploads section (#83, "Layout", item 6), while the queue holds a file:
 * "4 of 12 uploaded", then one row a file, its key in mono over its state.
 * While the file is sent, the state is a `Progress` labelled "Uploading"
 * with its percent; otherwise it is a line of text ("Waiting", "Uploaded",
 * "Already exists" with **Replace** and **Skip**, "Failed:" and why in
 * `destructive` with an icon, "Skipped", "Canceled"), with no empty track
 * to read as a divider (DESIGN.md: no decorative lines). A file still to go
 * has a cancel button. Several conflicts get **Replace all**, which asks
 * first, and **Skip all**.
 *
 * A pick of thousands of files stays light: the section draws the files in
 * flight, every failure and conflict, the next waiting files and the latest
 * finished ones (`shownRows`), counts the rest, and redraws a row only when
 * it changed (the queue keeps each row's object, and `UploadRow` is
 * memoised).
 *
 * When a row's buttons go (Replace, Skip, Cancel upload), focus moves to the
 * next row that has buttons, or to the heading when none is left; so it
 * does after Replace all, Skip all, Cancel all and Clear finished. A Clear
 * finished that empties the queue takes the section away with it, so
 * `onEmptied` hands focus back to the page.
 */
export function UploadsSection({
  queue,
  config,
  onEmptied,
}: {
  queue: UploadQueue;
  config: Pick<FilesConfig, "allowed" | "limits"> | undefined;
  /** The queue is empty and the section goes: the page places focus. */
  onEmptied: () => void;
}) {
  const items = useUploads(queue, (snapshot) => snapshot.items);
  const now = useClock();
  const [confirming, setConfirming] = useState(false);
  const [focusTarget, setFocusTarget] = useState<FocusTarget>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const headingRef = useRef<HTMLSpanElement>(null);
  // Replace all confirmed: the dialog hands focus to the heading as it closes.
  const replacedAll = useRef(false);

  const { rows, hidden } = shownRows(items);
  const { earlier, later } = describeHidden(hidden);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const conflicts = items.filter((item) => item.state === "exists");
  const finished = items.some((item) =>
    ["uploaded", "failed", "skipped", "canceled"].includes(item.state),
  );
  const running = items.some((item) => ["waiting", "signing", "uploading"].includes(item.state));

  // A stable callback, so a memoised row is not redrawn for its sake.
  const act = useCallback(
    (id: number, action: RowAction) => {
      const shown = rowsRef.current;
      const index = shown.findIndex((row) => row.id === id);
      const next =
        shown.slice(index + 1).find(actionable) ??
        shown.slice(0, Math.max(index, 0)).findLast(actionable);
      setFocusTarget(next?.id ?? "heading");
      queue[action](id);
    },
    [queue],
  );

  useEffect(() => {
    if (focusTarget === null) {
      return;
    }
    if (focusTarget !== "heading") {
      const button = listRef.current?.querySelector<HTMLElement>(
        `[data-upload="${focusTarget}"] button`,
      );
      if (button) {
        button.focus();
        setFocusTarget(null);
        return;
      }
    }
    headingRef.current?.focus();
    setFocusTarget(null);
  }, [focusTarget]);

  const all = (run: () => void) => () => {
    run();
    setFocusTarget("heading");
  };

  return (
    <Section
      title={
        // Focus lands here once no row has buttons left.
        <span ref={headingRef} tabIndex={-1}>
          Uploads
        </span>
      }
      description={describeQueue(items)}
      action={
        <>
          {running ? (
            <Button variant="outline" size="sm" onClick={all(() => queue.cancelAll())}>
              Cancel all
            </Button>
          ) : null}
          {finished ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                queue.clearFinished();
                if (queue.getSnapshot().items.length === 0) {
                  onEmptied();
                } else {
                  setFocusTarget("heading");
                }
              }}
            >
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
            <Button variant="outline" size="sm" onClick={all(() => queue.skipAll())}>
              Skip all
            </Button>
          </div>
        </div>
      ) : null}
      {/* The older finished files, counted above the latest ones shown. */}
      {earlier ? <p className="text-muted-foreground">{earlier}</p> : null}
      <ul ref={listRef} className="flex flex-col gap-4">
        {rows.map((item) => (
          <UploadRow key={item.id} item={item} config={config} now={now} onAct={act} />
        ))}
      </ul>
      {later ? <p className="text-muted-foreground">{later}</p> : null}
      <ReplaceAllDialog
        conflicts={conflicts}
        open={confirming && conflicts.length > 0}
        onOpenChange={setConfirming}
        finalFocus={() => {
          const replaced = replacedAll.current;
          replacedAll.current = false;
          return replaced ? headingRef.current : true;
        }}
        onConfirm={() => {
          replacedAll.current = true;
          queue.replaceAll();
          setConfirming(false);
        }}
      />
    </Section>
  );
}

/** A row's state, in words. */
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

/** One file's row, redrawn only when the queue gives it a new row object. */
const UploadRow = memo(function UploadRow({
  item,
  config,
  now,
  onAct,
}: {
  item: UploadView;
  config: Pick<FilesConfig, "allowed" | "limits"> | undefined;
  now: number;
  onAct: (id: number, action: RowAction) => void;
}) {
  const active = item.state === "waiting" || item.state === "signing" || item.state === "uploading";
  const sending = item.state === "signing" || item.state === "uploading";
  const failed = item.state === "failed" && item.failure !== undefined;

  return (
    <li data-upload={item.id} className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <span className="min-w-0 font-mono wrap-anywhere">{item.key}</span>
        {active ? (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Cancel upload"
            onClick={() => onAct(item.id, "cancel")}
          >
            <XIcon />
          </Button>
        ) : item.state === "exists" ? (
          <div className="flex shrink-0 items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => onAct(item.id, "replace")}>
              Replace
            </Button>
            <Button variant="outline" size="sm" onClick={() => onAct(item.id, "skip")}>
              Skip
            </Button>
          </div>
        ) : null}
      </div>
      {sending ? (
        <Progress value={percentOf(item)}>
          <ProgressLabel className="min-w-0">
            {stateLabel(item)}
            {/* The bar's name says which file it is. */}
            <span className="sr-only">, {item.key}</span>
          </ProgressLabel>
          <ProgressValue />
        </Progress>
      ) : failed && item.failure ? (
        <p className="flex min-w-0 items-start gap-1.5 font-medium text-destructive">
          {/* A box one line tall keeps the icon beside the first line. */}
          <span className="flex h-5 shrink-0 items-center">
            <CircleAlertIcon className="size-4" aria-hidden="true" />
          </span>
          <span className="min-w-0">Failed: {describeFailure(item.failure, item.key, config)}</span>
        </p>
      ) : (
        <p className="min-w-0 font-medium">
          {stateLabel(item)}
          {item.state === "exists" && item.existing ? (
            <span className="font-normal text-muted-foreground">
              {" "}
              ({formatBytes(item.existing.size)}, uploaded{" "}
              <RelativeTime iso={item.existing.uploadedAt} now={now} />)
            </span>
          ) : null}
        </p>
      )}
    </li>
  );
});

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
  finalFocus,
}: {
  conflicts: readonly UploadView[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  /** Where focus goes as the dialog closes: the heading after a confirm. */
  finalFocus: () => HTMLElement | null | boolean;
}) {
  const listed = conflicts.slice(0, LISTED_NAMES);
  const more = conflicts.length - listed.length;

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent finalFocus={finalFocus}>
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
