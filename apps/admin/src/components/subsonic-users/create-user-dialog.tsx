import { type FormEvent, useState } from "react";

import { PasswordInput } from "@/components/subsonic-users/password-input";
import {
  AdminSwitchField,
  LibrariesField,
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
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { createSubsonicUser, type LibraryName } from "@/lib/api";
import { MAX_USERNAME_LENGTH } from "@/lib/errors";
import { checkedLibraries, librariesError } from "@/lib/subsonic-users";

/**
 * Creates a Subsonic user: a username, a password and the **Subsonic admin**
 * switch. While no Subsonic admin exists the switch is locked on, since the
 * server would refuse any other user (`admin_required`, #82).
 *
 * Where more than one library exists, `libraries` lists them, and a user who
 * is not an admin gets the ones checked, starting from `defaultLibraryIds`
 * (#84). With one library it is empty: no field shows, and the server gives
 * the new user its default, as before.
 */
export function CreateUserDialog({
  open,
  onOpenChange,
  adminRequired,
  libraries,
  defaultLibraryIds,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  adminRequired: boolean;
  libraries: readonly LibraryName[];
  defaultLibraryIds: readonly number[];
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        {/* The popup unmounts once closed: each opening starts from empty fields. */}
        <CreateUserForm
          adminRequired={adminRequired}
          libraries={libraries}
          defaultLibraryIds={defaultLibraryIds}
          onDone={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

function CreateUserForm({
  adminRequired,
  libraries,
  defaultLibraryIds,
  onDone,
}: {
  adminRequired: boolean;
  libraries: readonly LibraryName[];
  defaultLibraryIds: readonly number[];
  onDone: () => void;
}) {
  const [isAdmin, setIsAdmin] = useState(adminRequired);
  // Null until a box is touched: the defaults show, even ones that arrive
  // after the dialog opened.
  const [chosen, setChosen] = useState<readonly number[] | null>(null);
  const libraryIds = checkedLibraries(chosen, defaultLibraryIds);
  const { fieldErrors, clear, report, onChange, drop } = useUserFieldErrors();
  const admin = adminRequired || isAdmin;
  const choosesLibraries = libraries.length > 0 && !admin;

  const mutation = useUserWrite({
    mutationFn: createSubsonicUser,
    succeeded: (user) => ({
      title: "Subsonic user created",
      description: `${user.username} can now sign in from a Subsonic client.`,
    }),
    fields: true,
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const target = event.currentTarget;
    const form = new FormData(target);
    clear();
    if (choosesLibraries && librariesError(admin, libraryIds) !== null) {
      // "Choose at least one library." shows beside the boxes already.
      return;
    }
    mutation.mutate(
      {
        username: String(form.get("username") ?? ""),
        password: String(form.get("password") ?? ""),
        isAdmin: admin,
        ...(choosesLibraries ? { libraryIds: [...libraryIds] } : {}),
      },
      {
        // The toast is the mutation's (useUserWrite); this is only the dialog's part.
        onSuccess: onDone,
        onError: (error) => {
          if (!report(error, form, target)) {
            // Not a field's to show: the dialog closes, so that its backdrop
            // does not blur the toast that says why.
            onDone();
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
          checked={admin}
          onCheckedChange={setIsAdmin}
          locked={
            adminRequired
              ? "There is no Subsonic admin yet, so this user must be one: library scans and the playlist import need one."
              : undefined
          }
        />
        {libraries.length > 0 ? (
          <LibrariesField
            libraries={libraries}
            isAdmin={admin}
            checked={libraryIds}
            onCheckedChange={(next) => {
              setChosen(next);
              drop("libraries");
            }}
            error={fieldErrors.libraries ?? librariesError(admin, libraryIds) ?? undefined}
          />
        ) : null}
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
