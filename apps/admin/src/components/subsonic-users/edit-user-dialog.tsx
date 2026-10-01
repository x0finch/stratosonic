import { TriangleAlertIcon } from "lucide-react";
import { type FormEvent, useState } from "react";

import {
  AdminSwitchField,
  UserFieldError,
  useUserFieldErrors,
  useUserWrite,
} from "@/components/subsonic-users/user-form";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { type SubsonicUser, updateSubsonicUser } from "@/lib/api";
import { MAX_USERNAME_LENGTH } from "@/lib/errors";
import { userChanges, userNamesMatch } from "@/lib/subsonic-users";

/**
 * Renames a Subsonic user, or turns **Subsonic admin** on or off. The server
 * refuses to demote the last Subsonic admin (`last_admin`), which is a toast.
 */
export function EditUserDialog({
  user,
  open,
  onOpenChange,
}: {
  user: SubsonicUser | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        {user && <EditUserForm key={user.id} user={user} onDone={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}

function EditUserForm({ user, onDone }: { user: SubsonicUser; onDone: () => void }) {
  const [username, setUsername] = useState(user.username);
  const [isAdmin, setIsAdmin] = useState(user.isAdmin);
  const { fieldErrors, clear, report, onChange } = useUserFieldErrors();

  const mutation = useUserWrite({
    mutationFn: (changes: { username?: string; isAdmin?: boolean }) =>
      updateSubsonicUser(user.id, changes),
    succeeded: (saved) => ({
      title: "Subsonic user saved",
      description: savedDescription(user, saved),
    }),
    fields: true,
  });

  // A rename signs the user's clients out only if the server sees another
  // name: a change of case alone is the same name to Subsonic sign-in.
  const renamed = username.trim() !== "" && !userNamesMatch(username.trim(), user.username);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const target = event.currentTarget;
    const form = new FormData(target);
    clear();
    const changes = userChanges(user, { username, isAdmin });
    if (!changes) {
      onDone();
      return;
    }
    mutation.mutate(changes, {
      // The toast is the mutation's (useUserWrite); this is only the dialog's part.
      onSuccess: onDone,
      onError: (error) => {
        if (!report(error, form, target)) {
          // Not a field's to show: the dialog closes, so that its backdrop
          // does not blur the toast that says why.
          onDone();
        }
      },
    });
  }

  return (
    <form onSubmit={onSubmit} onChange={onChange} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>Edit {user.username}</DialogTitle>
        <DialogDescription>
          Rename this Subsonic user, or change whether they are a Subsonic admin.
        </DialogDescription>
      </DialogHeader>
      <FieldGroup>
        <Field data-invalid={fieldErrors.username ? true : undefined}>
          <FieldLabel htmlFor="username">Username</FieldLabel>
          <Input
            id="username"
            name="username"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={MAX_USERNAME_LENGTH}
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            aria-invalid={fieldErrors.username ? true : undefined}
            required
          />
          <UserFieldError message={fieldErrors.username} />
        </Field>
        {renamed && (
          <Alert>
            <TriangleAlertIcon />
            <AlertDescription>
              Renaming signs {user.username} out of every Subsonic client until the client is set to
              the new name.
            </AlertDescription>
          </Alert>
        )}
        <AdminSwitchField checked={isAdmin} onCheckedChange={setIsAdmin} />
      </FieldGroup>
      <DialogFooter>
        <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
        <Button type="submit" disabled={mutation.isPending}>
          {mutation.isPending ? "Saving…" : "Save"}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** What the save changed, in words, for its toast. */
function savedDescription(before: SubsonicUser, after: SubsonicUser): string {
  const parts: string[] = [];
  if (after.username !== before.username) {
    parts.push(`${before.username} is now ${after.username}.`);
  }
  if (after.isAdmin !== before.isAdmin) {
    parts.push(
      after.isAdmin
        ? `${after.username} is now a Subsonic admin.`
        : `${after.username} is no longer a Subsonic admin.`,
    );
  }
  return parts.join(" ") || `${after.username} is saved.`;
}
