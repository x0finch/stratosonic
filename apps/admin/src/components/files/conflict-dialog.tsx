import { RelativeTime } from "@/components/relative-time";
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
import { useClock } from "@/hooks/use-clock";
import { formatBytes, formatCount } from "@/lib/format";
import { type ConflictDecision, describeConflicts, type UploadConflict } from "@/lib/uploads";

/** The most conflicts the dialog names; the rest are counted. */
export const LISTED_CONFLICTS = 10;

/**
 * The one question a pick with conflicts asks (#141), before any upload
 * starts, as Drive, OneDrive and Windows ask it: "3 of 25 files already
 * exist", the first `LISTED_CONFLICTS` of them, each with what is stored
 * (its size and age), then "and N more", and three answers for all of
 * them at once: **Replace them** (signed with `overwrite`, which keeps a
 * track's id and its stars, ratings and play counts, ADR-0002), **Skip
 * them** (the rest still go), or **Cancel** (nothing goes; so does
 * Escape). There is no choice per file and no "keep both".
 *
 * Each name is the file's path under the folder on screen, so two files of
 * one name in different folders of a folder pick stay apart.
 */
export function ConflictDialog({
  open,
  conflicts,
  total,
  folder,
  onDecide,
}: {
  open: boolean;
  conflicts: readonly UploadConflict[];
  /** The files of the pick, the conflicts among them. */
  total: number;
  /** The folder on screen, which every key starts with. */
  folder: string;
  onDecide: (decision: ConflictDecision) => void;
}) {
  const now = useClock();
  const listed = conflicts.slice(0, LISTED_CONFLICTS);
  const more = conflicts.length - listed.length;

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          onDecide("cancel");
        }
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{describeConflicts(conflicts.length, total)}</AlertDialogTitle>
          <AlertDialogDescription render={<div />} className="flex flex-col gap-3">
            <ul className="flex flex-col gap-2 text-left">
              {listed.map(({ upload, existing }) => {
                const name = upload.key.startsWith(folder)
                  ? upload.key.slice(folder.length)
                  : upload.key;
                return (
                  <li key={upload.key} className="flex min-w-0 flex-col">
                    <span className="truncate text-foreground" title={name}>
                      {name}
                    </span>
                    <span className="text-xs">
                      {formatBytes(existing.size)}, uploaded{" "}
                      <RelativeTime iso={existing.uploadedAt} now={now} />
                    </span>
                  </li>
                );
              })}
              {more > 0 ? <li className="text-left">and {formatCount(more)} more</li> : null}
            </ul>
            <p>
              Replace them, or skip them and upload the rest. A replaced file is lost; a replaced
              track keeps its stars, ratings and play counts.
            </p>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="outline" onClick={() => onDecide("skip")}>
            Skip them
          </AlertDialogAction>
          <AlertDialogAction variant="destructive" onClick={() => onDecide("replace")}>
            Replace them
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
