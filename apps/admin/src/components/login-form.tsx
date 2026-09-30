import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useRouter } from "@tanstack/react-router";
import { cn } from "cn";
import type { ComponentProps, FormEvent } from "react";

import { ErrorAlert } from "@/components/error-alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { meQuery, setupStateQuery, signIn } from "@/lib/api";
import { MAX_PASSWORD_LENGTH, MAX_USERNAME_LENGTH } from "@/lib/errors";
import { toastError } from "@/lib/toasts";

/**
 * The login-01 block's form, signing in with a username rather than an email.
 * It has no "Forgot your password?" link: the setup token only sets the server
 * up (#105). Its sign-up line is the first-run setup, shown only while
 * `GET /api/setup` allows it.
 * A failed sign-in says why in a toast; a server that cannot say what the
 * setup token may do says why on the page, for as long as that lasts.
 */
export function LoginForm({
  redirectTo,
  className,
  ...props
}: ComponentProps<"div"> & {
  /** Where to go once signed in: a path `safeRedirect` has vetted. */
  redirectTo: string;
}) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const setupState = useQuery(setupStateQuery);

  const mutation = useMutation({
    mutationFn: signIn,
    onSuccess: async () => {
      await queryClient.fetchQuery({ ...meQuery, staleTime: 0 });
      await router.navigate({ href: redirectTo, replace: true });
    },
    onError: (error) => toastError(error),
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    mutation.mutate({
      username: String(form.get("username") ?? ""),
      password: String(form.get("password") ?? ""),
    });
  }

  return (
    <div className={cn("flex flex-col gap-6", className)} {...props}>
      <Card>
        <CardHeader>
          <CardTitle>Sign in to Stratosonic</CardTitle>
          <CardDescription>Enter the username and password of your console account</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit}>
            <FieldGroup>
              {/* A server that refuses every `/api` call (without its
                  encryption key, say) refuses the setup state as well, and
                  says why here, before anyone types. That is the state of the
                  page, not an action's outcome, so it stays until it changes
                  rather than going with a toast. */}
              {setupState.error && <ErrorAlert error={setupState.error} />}
              <Field>
                <FieldLabel htmlFor="username">Username</FieldLabel>
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
                <FieldLabel htmlFor="password">Password</FieldLabel>
                <Input
                  id="password"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  maxLength={MAX_PASSWORD_LENGTH}
                  required
                />
              </Field>
              <Field>
                <Button type="submit" disabled={mutation.isPending}>
                  {mutation.isPending ? "Signing in…" : "Sign in"}
                </Button>
                {setupState.data === "needs-setup" && (
                  <FieldDescription className="text-center">
                    No owner yet? <Link to="/setup">Set up the server</Link>
                  </FieldDescription>
                )}
              </Field>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
