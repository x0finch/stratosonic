import { useMutation } from "@tanstack/react-query";
import { cn } from "cn";
import { CircleCheckIcon } from "lucide-react";
import { type ComponentProps, type FormEvent, useState } from "react";

import { ErrorAlert } from "@/components/error-alert";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ApiError, changePassword } from "@/lib/api";
import { describeError, MAX_PASSWORD_LENGTH } from "@/lib/errors";

/**
 * The login-01 block's form with the change-password fields (#81): the
 * current password, then the new one twice. The server keeps this session
 * and signs the user's others out.
 */
export function ChangePasswordForm({
  userName,
  className,
  ...props
}: ComponentProps<"div"> & { userName: string }) {
  const [mismatch, setMismatch] = useState(false);

  const mutation = useMutation({ mutationFn: changePassword });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const target = event.currentTarget;
    const form = new FormData(target);
    const newPassword = String(form.get("new-password") ?? "");
    if (newPassword !== String(form.get("confirm") ?? "")) {
      setMismatch(true);
      return;
    }
    setMismatch(false);
    mutation.mutate(
      { currentPassword: String(form.get("current-password") ?? ""), newPassword },
      { onSuccess: () => target.reset() },
    );
  }

  // A wrong current password belongs to its field; anything else, to the form.
  const wrongPassword =
    mutation.error instanceof ApiError && mutation.error.code === "wrong_password";

  return (
    <div className={cn("flex flex-col gap-6", className)} {...props}>
      <Card>
        <CardHeader>
          <CardTitle>Change password</CardTitle>
          <CardDescription>Your Subsonic clients use the same password</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit}>
            <FieldGroup>
              {mutation.isSuccess && (
                <Alert>
                  <CircleCheckIcon />
                  <AlertTitle>Password changed</AlertTitle>
                  <AlertDescription>
                    Your other sessions are signed out. Use the new password in your Subsonic
                    clients too.
                  </AlertDescription>
                </Alert>
              )}
              {mutation.error && !wrongPassword && <ErrorAlert error={mutation.error} />}
              {/* For password managers, which file a password under a username. */}
              <input
                type="text"
                name="username"
                autoComplete="username"
                value={userName}
                readOnly
                hidden
              />
              <Field data-invalid={wrongPassword || undefined}>
                <FieldLabel htmlFor="current-password">Current password</FieldLabel>
                <Input
                  id="current-password"
                  name="current-password"
                  type="password"
                  autoComplete="current-password"
                  maxLength={MAX_PASSWORD_LENGTH}
                  aria-invalid={wrongPassword || undefined}
                  required
                />
                {wrongPassword && <FieldError>{describeError(mutation.error).title}.</FieldError>}
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
