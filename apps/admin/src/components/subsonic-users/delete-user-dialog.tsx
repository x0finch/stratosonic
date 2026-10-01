import { useMutation, useQueryClient } from "@tanstack/react-query";

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
import { deleteSubsonicUser, type SubsonicUser } from "@/lib/api";
import { afterUserWrite, deleteConsequences } from "@/lib/subsonic-users";
import { toastError, toastSuccess } from "@/lib/toasts";

/**
 * Deletes a Subsonic user after confirming, saying what goes with them (#82,
 * open question 1 as the owner decided it): their annotations, bookmarks and
 * play queue, and their playlists with the files in the bucket. The server
 * refuses to delete the last Subsonic admin (`last_admin`), which is a toast.
 */
export function DeleteUserDialog({
  user,
  open,
  onOpenChange,
}: {
  user: SubsonicUser | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: deleteSubsonicUser,
    onSettled: () => afterUserWrite(queryClient),
  });

  function onDelete() {
    if (!user) {
      return;
    }
    mutation.mutate(user.id, {
      onSuccess: () => {
        toastSuccess(
          "Subsonic user deleted",
          `${user.username} can no longer sign in from a Subsonic client.`,
        );
        onOpenChange(false);
      },
      onError: (error) => {
        toastError(error);
        onOpenChange(false);
      },
    });
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {user?.username}?</AlertDialogTitle>
          <AlertDialogDescription>
            {user?.username} can no longer sign in from a Subsonic client.{" "}
            {user && deleteConsequences(user.playlistCount)} This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onDelete} disabled={mutation.isPending}>
            {mutation.isPending ? "Deleting…" : "Delete user"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
