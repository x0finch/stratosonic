import { useMutation } from "@tanstack/react-query";
import { cn } from "cn";
import { type ComponentProps, type FormEvent, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { changePassword } from "@/lib/api";
import { MAX_PASSWORD_LENGTH } from "@/lib/errors";
import {
  type FieldErrors,
  fieldErrorsFrom,
  NO_FIELD_ERRORS,
  stillCurrent,
  withoutFieldError,
} from "@/lib/field-errors";
import { toastError, toastSuccess } from "@/lib/toasts";

/** The refusals that belong to a field: a wrong current password. */
const FIELDS_BY_CODE = { wrong_password: "current-password" };

/**
 * The login-01 block's form with the change-password fields (#81): the
 * current password, then the new one twice. The server keeps this session
 * and signs the console user's others out.
 */
export function ChangePasswordForm({
  username,
  className,
  ...props
}: ComponentProps<"div"> & { username: string }) {
  const [mismatch, setMismatch] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>(NO_FIELD_ERRORS);

  // A wrong current password belongs to its field; any other outcome is a
  // toast.
  const mutation = useMutation({
    mutationFn: changePassword,
    onSuccess: () => toastSuccess("Password changed", "Your other sessions are signed out."),
    onError: (error) => {
      if (!fieldErrorsFrom(error, FIELDS_BY_CODE)) {
        toastError(error);
      }
    },
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const target = event.currentTarget;
    const form = new FormData(target);
    // A new attempt: what the server said of the last one no longer holds,
    // whether or not this one gets past the checks below (#103).
    setFieldErrors(NO_FIELD_ERRORS);
    const newPassword = String(form.get("new-password") ?? "");
    if (newPassword !== String(form.get("confirm") ?? "")) {
      setMismatch(true);
      return;
    }
    setMismatch(false);
    mutation.mutate(
      { currentPassword: String(form.get("current-password") ?? ""), newPassword },
      {
        onSuccess: () => target.reset(),
        onError: (error) => {
          const reported = fieldErrorsFrom(error, FIELDS_BY_CODE);
          if (reported) {
            setFieldErrors(stillCurrent(reported, form, new FormData(target)));
          }
        },
      },
    );
  }

  // A server-reported error belongs to the value it was reported for: it goes
  // as soon as its field changes (#103).
  function onChange(event: FormEvent<HTMLFormElement>) {
    if (event.target instanceof HTMLInputElement) {
      const { name } = event.target;
      setFieldErrors((errors) => withoutFieldError(errors, name));
    }
  }

  const wrongPassword = fieldErrors["current-password"];

  return (
    <div className={cn("flex flex-col gap-6", className)} {...props}>
      <Card>
        <CardHeader>
          <CardTitle>Change password</CardTitle>
          <CardDescription>
            The password of your console account. Subsonic passwords do not change.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} onChange={onChange}>
            <FieldGroup>
              {/* For password managers, which file a password under a username. */}
              <input
                type="text"
                name="username"
                autoComplete="username"
                value={username}
                readOnly
                hidden
              />
              <Field data-invalid={wrongPassword ? true : undefined}>
                <FieldLabel htmlFor="current-password">Current password</FieldLabel>
                <Input
                  id="current-password"
                  name="current-password"
                  type="password"
                  autoComplete="current-password"
                  maxLength={MAX_PASSWORD_LENGTH}
                  aria-invalid={wrongPassword ? true : undefined}
                  required
                />
                {wrongPassword && <FieldError>{wrongPassword}</FieldError>}
              </Field>
              <Field>
                <FieldLabel htmlFor="new-password">New password</FieldLabel>
                <Input
                  id="new-password"
                  name="new-password"
                  type="password"
                  autoComplete="new-password"
                  maxLength={MAX_PASSWORD_LENGTH}
                  required
                />
              </Field>
              <Field data-invalid={mismatch || undefined}>
                <FieldLabel htmlFor="confirm">Confirm new password</FieldLabel>
                <Input
                  id="confirm"
                  name="confirm"
                  type="password"
                  autoComplete="new-password"
                  maxLength={MAX_PASSWORD_LENGTH}
                  aria-invalid={mismatch || undefined}
                  required
                />
                {mismatch && <FieldError>The passwords do not match.</FieldError>}
              </Field>
              <Field>
                <Button type="submit" disabled={mutation.isPending}>
                  {mutation.isPending ? "Changing password…" : "Change password"}
                </Button>
              </Field>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
