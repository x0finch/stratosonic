import { useQuery } from "@tanstack/react-query";
import { CircleAlertIcon, CircleCheckIcon, XIcon } from "lucide-react";
import { memo, useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Progress, ProgressLabel, ProgressValue } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { useUploadQueue, useUploads } from "@/hooks/use-upload-queue";
import type { FilesConfig } from "@/lib/api";
import { filesConfigQuery } from "@/lib/files";
import {
  describeFailure,
  describeHidden,
  describeQueue,
  describeUploadsStatus,
  percentOf,
  shownRows,
  splitKey,
  type UploadQueue,
  type UploadView,
  uploadsStatus,
} from "@/lib/uploads";

/** Where focus goes once the row it was on loses its button: a row, or the heading. */
type FocusTarget = number | "heading" | null;

/** Whether a row has a button: Cancel upload, while the file is still to go. */
function actionable(item: UploadView): boolean {
  return item.state === "waiting" || item.state === "signing" || item.state === "uploading";
}

/**
 * Where focus goes once the queue empties and the trigger goes with it:
 * the Files page's Upload, where it is on screen (components/files/
 * upload-menu.tsx marks it), or else the page's h1.
 */
function focusUploadAnchor(): void {
  const upload = document.querySelector<HTMLElement>("[data-upload-trigger]");
  if (upload) {
    upload.focus();
    return;
  }
  const heading = document.querySelector<HTMLElement>('[role="heading"][aria-level="1"]');
  heading?.setAttribute("tabindex", "-1");
  heading?.focus();
}

/**
 * The header's Uploads trigger (#141), next to the theme toggle, while the
 * session's upload queue holds a file: on every page of the shell, since
 * the queue outlives the Files page. Its label is the queue's state in
 * words: a spinner and "Uploading 3 of 12", "2 need attention" (failures)
 * with an icon, or "Uploads done" (lib/uploads.ts, `describeUploadsStatus`).
 *
 * It opens the upload list in a popover, which never opens by itself: a
 * run's failures are told by its toast and by the label. Conflicts never
 * get here: the Files page settles them in its conflict dialog before
 * anything is signed. The trigger redraws only when its words change, not
 * on every upload's progress.
 */
export function UploadsPopover() {
  const queue = useUploadQueue();
  const status = useUploads(queue, (snapshot) => uploadsStatus(snapshot.items));
  const label = useUploads(queue, (snapshot) => describeUploadsStatus(snapshot.items));
  // The rows' failure words read the upload limits, which the Files page
  // read before any file joined the queue: read from the cache only, and
  // kept there while the trigger shows.
  const { data: config } = useQuery({ ...filesConfigQuery, enabled: false });
  // Clear finished emptied the queue: focus goes to the page once the
  // trigger has gone.
  const emptied = useRef(false);

  useEffect(() => {
    if (status === null && emptied.current) {
      emptied.current = false;
      focusUploadAnchor();
    }
  }, [status]);

  if (status === null) {
    return null;
  }

  return (
    <Popover>
      <PopoverTrigger render={<Button variant="outline" />}>
        {status === "running" ? (
          <Spinner data-icon="inline-start" aria-hidden="true" />
        ) : status === "attention" ? (
          <CircleAlertIcon data-icon="inline-start" aria-hidden="true" />
        ) : (
          <CircleCheckIcon data-icon="inline-start" aria-hidden="true" />
        )}
        {label}
      </PopoverTrigger>
      {/* At most 32rem tall: a long list scrolls inside, below its heading
          and buttons. Narrower than a phone's screen, wider from `sm`. */}
      <PopoverContent align="end" className="max-h-128 w-80 gap-4 p-4 sm:w-md">
        <UploadList
          queue={queue}
          config={config}
          onEmptied={() => {
            emptied.current = true;
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

/**
 * The upload list (#83, "Layout", item 6), in the Uploads popover: "4 of 12
 * uploaded", then one row a file: the file's name, the folder it goes to
 * beneath (metadata, the path in mono), then its state. While the file is
 * sent, the state is a `Progress` labelled "Uploading" with its percent;
 * otherwise it is a line of text ("Waiting", "Uploaded", "Failed:" and why
 * in `destructive` with an icon, "Canceled"), with no empty track to read
 * as a divider (DESIGN.md: no decorative lines). A file still to go has a
 * cancel button. The rows scroll in a `ScrollArea`, below the heading and
 * the buttons.
 *
 * A pick of thousands of files stays light: the list draws the files in
 * flight, every failure, the next waiting files and the latest finished
 * ones (`shownRows`), counts the rest, and redraws a row only when it
 * changed (the queue keeps each row's object, and `UploadRow` is memoised).
 *
 * When a row's button goes (Cancel upload), focus moves to the next row
 * that has one, or to the heading when none is left; so it does after
 * Cancel all and Clear finished. A Clear finished that empties the queue
 * takes the trigger and the popover away with it, so `onEmptied` hands
 * focus back to the page.
 */
function UploadList({
  queue,
  config,
  onEmptied,
}: {
  queue: UploadQueue;
  config: Pick<FilesConfig, "allowed" | "limits"> | undefined;
  /** The queue is empty, and the trigger goes: the page gets focus. */
  onEmptied: () => void;
}) {
  const items = useUploads(queue, (snapshot) => snapshot.items);
  const [focusTarget, setFocusTarget] = useState<FocusTarget>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const { rows, hidden } = shownRows(items);
  const { earlier, later } = describeHidden(hidden);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const finished = items.some((item) => !actionable(item));
  const running = items.some(actionable);

  // A stable callback, so a memoised row is not redrawn for its sake.
  const cancel = useCallback(
    (id: number) => {
      const shown = rowsRef.current;
      const index = shown.findIndex((row) => row.id === id);
      const next =
        shown.slice(index + 1).find(actionable) ??
        shown.slice(0, Math.max(index, 0)).findLast(actionable);
      setFocusTarget(next?.id ?? "heading");
      queue.cancel(id);
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

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <PopoverHeader className="min-w-0">
          {/* Focus lands here once no row has a button left. */}
          <PopoverTitle ref={headingRef} tabIndex={-1}>
            Uploads
          </PopoverTitle>
          <PopoverDescription>{describeQueue(items)}</PopoverDescription>
        </PopoverHeader>
        <div className="flex shrink-0 items-center gap-2">
          {running ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                queue.cancelAll();
                setFocusTarget("heading");
              }}
            >
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
        </div>
      </div>
      {/* The rows scroll here once the popover reaches its height: a scroll
          container may shrink below its content in the popup's column. */}
      <ScrollArea className="group/list flex min-h-0 flex-col">
        {/* Clear of the scrollbar while there is one. */}
        <div className="flex flex-col gap-4 group-data-has-overflow-y/list:pr-4">
          {/* The older finished files, counted above the latest ones shown. */}
          {earlier ? <p className="text-muted-foreground">{earlier}</p> : null}
          <ul ref={listRef} className="flex flex-col gap-4">
            {rows.map((item) => (
              <UploadRow key={item.id} item={item} config={config} onCancel={cancel} />
            ))}
          </ul>
          {later ? <p className="text-muted-foreground">{later}</p> : null}
        </div>
      </ScrollArea>
    </>
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
    case "failed":
      return "Failed";
    case "canceled":
      return "Canceled";
  }
}

/** One file's row, redrawn only when the queue gives it a new row object. */
const UploadRow = memo(function UploadRow({
  item,
  config,
  onCancel,
}: {
  item: UploadView;
  config: Pick<FilesConfig, "allowed" | "limits"> | undefined;
  onCancel: (id: number) => void;
}) {
  const sending = item.state === "signing" || item.state === "uploading";
  const { name, folder } = splitKey(item.key);

  return (
    <li data-upload={item.id} className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        {/* The file's name is the row's line, cut short on one line with
            the whole name in its title (the text itself stays whole for a
            screen reader); the folder it goes to is metadata beneath. */}
        <div className="flex min-w-0 flex-col gap-1">
          <span className="truncate" title={name}>
            {name}
          </span>
          {folder ? (
            <span className="font-mono text-xs wrap-anywhere text-muted-foreground">{folder}</span>
          ) : null}
        </div>
        {actionable(item) ? (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Cancel upload"
            onClick={() => onCancel(item.id)}
          >
            <XIcon />
          </Button>
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
      ) : item.state === "failed" && item.failure ? (
        <p className="flex min-w-0 items-start gap-1.5 font-medium text-destructive">
          {/* A box one line tall keeps the icon beside the first line. */}
          <span className="flex h-5 shrink-0 items-center">
            <CircleAlertIcon className="size-4" aria-hidden="true" />
          </span>
          <span className="min-w-0">Failed: {describeFailure(item.failure, item.key, config)}</span>
        </p>
      ) : (
        <p className="min-w-0 font-medium">{stateLabel(item)}</p>
      )}
    </li>
  );
});
