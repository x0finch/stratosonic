import type { FormEvent } from "react";

import { PasswordInput } from "@/components/subsonic-users/password-input";
import {
  UserFieldError,
  useUserFieldErrors,
  useUserWrite,
} from "@/components/subsonic-users/user-form";
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
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { type SubsonicUser, setSubsonicPassword } from "@/lib/api";

/**
 * Sets a Subsonic user's password. No current password is asked for: a
 * Subsonic user never uses the console, and Navidrome asks none of an admin
 * changing another user's (#82).
 */
export function SetPasswordDialog({
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
        {user && <SetPasswordForm key={user.id} user={user} onDone={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}

function SetPasswordForm({ user, onDone }: { user: SubsonicUser; onDone: () => void }) {
  const { fieldErrors, clear, report, onChange } = useUserFieldErrors();

  const mutation = useUserWrite({
    mutationFn: (password: string) => setSubsonicPassword(user.id, password),
    succeeded: () => ({
      title: "Password set",
      description: `${user.username} signs in with the new password from now on; the old one no longer works.`,
    }),
    fields: true,
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const target = event.currentTarget;
    const form = new FormData(target);
    clear();
    mutation.mutate(String(form.get("password") ?? ""), {
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
        <DialogTitle>Set a password for {user.username}</DialogTitle>
        <DialogDescription>
          Their Subsonic clients need the new password to sign in again.
        </DialogDescription>
      </DialogHeader>
      <FieldGroup>
        {/* For password managers, which file a password under a username. */}
        <input
          type="text"
          name="username"
          autoComplete="username"
          value={user.username}
          readOnly
          hidden
        />
        <Field data-invalid={fieldErrors.password ? true : undefined}>
          <FieldLabel htmlFor="password">New password</FieldLabel>
          <PasswordInput
            id="password"
            name="password"
            aria-invalid={fieldErrors.password ? true : undefined}
            required
          />
          <UserFieldError message={fieldErrors.password} />
          <FieldDescription>Show it to check it before you set it.</FieldDescription>
        </Field>
      </FieldGroup>
      <DialogFooter>
        <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
        <Button type="submit" disabled={mutation.isPending}>
          {mutation.isPending ? "Setting password…" : "Set password"}
        </Button>
      </DialogFooter>
    </form>
  );
}
