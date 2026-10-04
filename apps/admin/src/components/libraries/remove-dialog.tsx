import { useLibraryWrite } from "@/components/libraries/library-form";
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
import { type Library, removeLibrary } from "@/lib/api";
import { removeConsequences, removedNotice } from "@/lib/libraries";

/**
 * Removes a library after confirming, saying what leaves with it (#84,
 * "Removing a library"): its tracks and albums, the playlists stored in its
 * bucket, and every annotation and bookmark on them, while the files in the
 * bucket stay. The library is gone for every reader at once, and the scan
 * deletes its rows. Library 1 offers no removal.
 */
export function RemoveDialog({
  library,
  open,
  onOpenChange,
}: {
  library: Library | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const mutation = useLibraryWrite({
    mutationFn: (target: Library) => removeLibrary(target.id),
    succeeded: (removed, target) => removedNotice(target, removed),
  });

  function onRemove() {
    if (!library) {
      return;
    }
    // Either way the dialog closes; the toast is the mutation's (useLibraryWrite).
    mutation.mutate(library, { onSettled: () => onOpenChange(false) });
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove {library?.name}?</AlertDialogTitle>
          <AlertDialogDescription>{library && removeConsequences(library)}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onRemove} disabled={mutation.isPending}>
            {mutation.isPending ? "Removing…" : "Remove library"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
