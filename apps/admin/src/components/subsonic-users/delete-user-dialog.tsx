import { useUserWrite } from "@/components/subsonic-users/user-form";
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
import { deleteConsequences } from "@/lib/subsonic-users";

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
  const mutation = useUserWrite({
    mutationFn: (target: SubsonicUser) => deleteSubsonicUser(target.id),
    succeeded: (_, target) => ({
      title: "Subsonic user deleted",
      description: `${target.username} can no longer sign in from a Subsonic client.`,
    }),
  });

  function onDelete() {
    if (!user) {
      return;
    }
    // Either way the dialog closes; the toast is the mutation's (useUserWrite).
    mutation.mutate(user, { onSettled: () => onOpenChange(false) });
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
