import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { cn } from "cn";
import { type ComponentProps, type FormEvent, type ReactNode, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { type SetupRequest, setupStateQuery } from "@/lib/api";
import { MAX_PASSWORD_LENGTH, MAX_USERNAME_LENGTH } from "@/lib/errors";
import { toastError, toastSuccess } from "@/lib/toasts";

/** The words that tell first-run setup and recovery apart. */
export interface SetupFormText {
  title: string;
  description: string;
  usernameLabel: string;
  passwordLabel: string;
  submit: string;
  pending: string;
  /** The toast that says what was done, shown on the sign-in screen. */
  doneTitle: string;
  doneDescription: string;
}

/**
 * The login-01 block's form with the setup token's fields: the first-run
 * setup and the owner's password reset. Both take the token, a username and a
 * password twice. Neither signs anybody in (#90), so both then go to the
 * sign-in screen, with a toast that says what was done; a refusal is a toast
 * too, and only the confirmation mismatch stays beside its field.
 */
export function SetupForm({
  text,
  submit,
  footer,
  className,
  ...props
}: ComponentProps<"div"> & {
  text: SetupFormText;
  /** `POST /api/setup` or `POST /api/setup/reset`. */
  submit: (request: SetupRequest) => Promise<void>;
  footer?: ReactNode;
}) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const [mismatch, setMismatch] = useState(false);

  const mutation = useMutation({
    mutationFn: submit,
    onSuccess: async () => {
      // The token is spent now; whatever the sign-in screen knew is stale.
      queryClient.removeQueries({ queryKey: setupStateQuery.queryKey });
      // Raised before navigating: the toaster sits above the router, so the
      // toast stays on screen as the sign-in screen opens.
      toastSuccess(text.doneTitle, text.doneDescription);
      await router.navigate({ to: "/login", replace: true });
    },
    onError: (error) => toastError(error),
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const password = String(form.get("password") ?? "");
    if (password !== String(form.get("confirm") ?? "")) {
      setMismatch(true);
      return;
    }
    setMismatch(false);
    mutation.mutate({
      token: String(form.get("token") ?? ""),
      username: String(form.get("username") ?? ""),
      password,
    });
  }

  return (
    <div className={cn("flex flex-col gap-6", className)} {...props}>
      <Card>
        <CardHeader>
          <CardTitle>{text.title}</CardTitle>
          <CardDescription>{text.description}</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="token">Setup token</FieldLabel>
                <Input
                  id="token"
                  name="token"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  required
                />
                <FieldDescription>The SETUP_TOKEN secret set on the Worker.</FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="username">{text.usernameLabel}</FieldLabel>
                <Input
                  id="username"
                  name="username"
                  autoComplete="username"
                  autoCapitalize="none"
                  spellCheck={false}
                  maxLength={MAX_USERNAME_LENGTH}
                  required
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="password">{text.passwordLabel}</FieldLabel>
                <Input
                  id="password"
                  name="password"
                  type="password"
                  autoComplete="new-password"
                  maxLength={MAX_PASSWORD_LENGTH}
                  required
                />
              </Field>
              <Field data-invalid={mismatch || undefined}>
                <FieldLabel htmlFor="confirm">Confirm password</FieldLabel>
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
                  {mutation.isPending ? text.pending : text.submit}
                </Button>
                {footer && <FieldDescription className="text-center">{footer}</FieldDescription>}
              </Field>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
