import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

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
import { Spinner } from "@/components/ui/spinner";
import { deleteFiles, deleteFolderRound } from "@/lib/api";
import {
  afterFilesChange,
  countOf,
  type DeleteOutcome,
  type DeleteTarget,
  deleteConsequences,
  deletedCount,
  deletedTitle,
  deleteTitle,
  listedNames,
  planDelete,
  runDelete,
  type WriteSchedule,
} from "@/lib/files";
import { formatCount } from "@/lib/format";
import { toastError, toastSuccess } from "@/lib/toasts";

/**
 * Deletes files and folders after confirming (#83, "Delete confirmation").
 * Deletes are permanent (owner decision 1): the dialog names what goes and
 * says it cannot be undone, and nothing offers an undo.
 *
 * The files go in requests of at most `batch` keys, then each folder by
 * `delete-folder` rounds until the server says `done`, while the button
 * counts the files deleted so far. The toast, the folder's new listing and
 * the scan line's schedule follow the mutation itself, so they hold even
 * if the page moves on meanwhile. The dialog stays open until the delete
 * ends, and cannot be dismissed while it runs.
 */
export function DeleteDialog({
  targets,
  open,
  onOpenChange,
  batch,
  rescanQuietSeconds,
  onDeleted,
}: {
  targets: readonly DeleteTarget[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  batch: number;
  rescanQuietSeconds: number;
  /** After the delete, what it did, and the schedule its last answer gave, if any. */
  onDeleted: (outcome: DeleteOutcome, schedule: WriteSchedule | undefined) => void;
}) {
  const queryClient = useQueryClient();
  const [progress, setProgress] = useState<number | null>(null);

  const mutation = useMutation({
    mutationFn: async (chosen: readonly DeleteTarget[]) => {
      setProgress(null);
      const outcome = await runDelete(
        planDelete(chosen, batch),
        { deleteFiles, deleteFolderRound },
        setProgress,
      );
      // Nothing deleted: a plain failure, which signs a session that ended
      // out (main.tsx) and is toasted below.
      if (outcome.error !== undefined && deletedCount(outcome) === 0) {
        throw outcome.error;
      }
      return outcome;
    },
    onSuccess: (outcome) => {
      const deleted = deletedCount(outcome);
      if (outcome.error === undefined) {
        toastSuccess(deletedTitle(outcome), "Tracks leave the library at the next scan.");
      } else {
        toastError(outcome.error, `The delete stopped after ${countOf(deleted, "file")}`);
      }
      onDeleted(outcome, outcome.schedule);
    },
    onError: (error) => toastError(error, "Nothing was deleted"),
    onSettled: () => {
      void afterFilesChange(queryClient);
      onOpenChange(false);
    },
  });

  const folders = targets.filter((target) => target.type === "folder");
  const [onlyFolder] = folders;
  const { names, more } = listedNames(targets);
  const running = mutation.isPending;

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!running) {
          onOpenChange(next);
        }
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{deleteTitle(targets)}</AlertDialogTitle>
          <AlertDialogDescription render={<div />} className="flex flex-col gap-3">
            <ul className="flex flex-col gap-1">
              {names.map((name) => (
                <li key={name} className="font-mono wrap-anywhere text-foreground">
                  {name}
                </li>
              ))}
              {more > 0 ? <li>and {formatCount(more)} more</li> : null}
            </ul>
            {folders.length === 1 && onlyFolder?.type === "folder" ? (
              <p>
                Everything in <span className="font-mono wrap-anywhere">{onlyFolder.prefix}</span>{" "}
                is deleted.
              </p>
            ) : folders.length > 1 ? (
              <p>Everything in these {folders.length} folders is deleted.</p>
            ) : null}
            <p>{deleteConsequences(rescanQuietSeconds)}</p>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={running}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={running}
            onClick={() => mutation.mutate(targets)}
          >
            {running ? (
              <>
                <Spinner data-icon="inline-start" aria-hidden="true" />
                Deleting…{progress ? ` ${countOf(progress, "file")}` : null}
              </>
            ) : (
              "Delete"
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
