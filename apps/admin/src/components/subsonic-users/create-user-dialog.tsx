import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";

import { PasswordInput } from "@/components/subsonic-users/password-input";
import {
  AdminSwitchField,
  UserFieldError,
  useUserFieldErrors,
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
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { createSubsonicUser } from "@/lib/api";
import { MAX_USERNAME_LENGTH } from "@/lib/errors";
import { afterUserWrite } from "@/lib/subsonic-users";
import { toastError, toastSuccess } from "@/lib/toasts";

/**
 * Creates a Subsonic user: a username, a password and the **Subsonic admin**
 * switch. While no Subsonic admin exists the switch is locked on, since the
 * server would refuse any other user (`admin_required`, #82).
 */
export function CreateUserDialog({
  open,
  onOpenChange,
  adminRequired,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  adminRequired: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        {/* The popup unmounts once closed: each opening starts from empty fields. */}
        <CreateUserForm adminRequired={adminRequired} onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function CreateUserForm({ adminRequired, onDone }: { adminRequired: boolean; onDone: () => void }) {
  const queryClient = useQueryClient();
  const [isAdmin, setIsAdmin] = useState(adminRequired);
  const { fieldErrors, clear, report, onChange } = useUserFieldErrors();

  const mutation = useMutation({
    mutationFn: createSubsonicUser,
    onSettled: () => afterUserWrite(queryClient),
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const target = event.currentTarget;
    const form = new FormData(target);
    clear();
    mutation.mutate(
      {
        username: String(form.get("username") ?? ""),
        password: String(form.get("password") ?? ""),
        isAdmin: adminRequired || isAdmin,
      },
      {
        onSuccess: (user) => {
          toastSuccess(
            "Subsonic user created",
            `${user.username} can now sign in from a Subsonic client.`,
          );
          onDone();
        },
        onError: (error) => {
          if (!report(error, form, target)) {
            toastError(error);
          }
        },
      },
    );
  }

  return (
    <form onSubmit={onSubmit} onChange={onChange} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>Add a Subsonic user</DialogTitle>
        <DialogDescription>
          The username and password a Subsonic client, such as Substreamer, signs in with.
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
            aria-invalid={fieldErrors.username ? true : undefined}
            required
          />
          <UserFieldError message={fieldErrors.username} />
        </Field>
        <Field data-invalid={fieldErrors.password ? true : undefined}>
          <FieldLabel htmlFor="password">Password</FieldLabel>
          <PasswordInput
            id="password"
            name="password"
            aria-invalid={fieldErrors.password ? true : undefined}
            required
          />
          <UserFieldError message={fieldErrors.password} />
        </Field>
        <AdminSwitchField
          checked={adminRequired || isAdmin}
          onCheckedChange={setIsAdmin}
          locked={
            adminRequired
              ? "There is no Subsonic admin yet, so this user must be one: library scans and the playlist import need one."
              : undefined
          }
        />
      </FieldGroup>
      <DialogFooter>
        <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
        <Button type="submit" disabled={mutation.isPending}>
          {mutation.isPending ? "Adding user…" : "Add user"}
        </Button>
      </DialogFooter>
    </form>
  );
}
