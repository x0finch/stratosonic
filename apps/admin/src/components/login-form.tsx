import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useRouter } from "@tanstack/react-router";
import { cn } from "cn";
import { CircleCheckIcon } from "lucide-react";
import type { ComponentProps, FormEvent } from "react";

import { ErrorAlert } from "@/components/error-alert";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { meQuery, setupStateQuery, signIn } from "@/lib/api";
import { MAX_PASSWORD_LENGTH, MAX_USERNAME_LENGTH } from "@/lib/errors";

/** What the setup screens send the visitor here to hear about. */
export type LoginNotice = "set-up" | "reset";

const NOTICES: Record<LoginNotice, { title: string; description: string }> = {
  "set-up": {
    title: "The operator account is created",
    description: "Sign in with its username and password.",
  },
  reset: {
    title: "The password is reset",
    description:
      "Sign in with the new password. Every other session of that operator is signed out.",
  },
};

/**
 * The login-01 block's form, signing in with a username rather than an email.
 * Its "Forgot your password?" link is the setup token's reset, and its sign-up
 * line the first-run setup, each shown only while `GET /api/setup` allows it.
 */
export function LoginForm({
  redirectTo,
  notice,
  className,
  ...props
}: ComponentProps<"div"> & {
  /** Where to go once signed in: a path `safeRedirect` has vetted. */
  redirectTo: string;
  notice?: LoginNotice;
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
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    mutation.mutate({
      username: String(form.get("username") ?? ""),
      password: String(form.get("password") ?? ""),
    });
  }

  const done = notice ? NOTICES[notice] : undefined;

  return (
    <div className={cn("flex flex-col gap-6", className)} {...props}>
      <Card>
        <CardHeader>
          <CardTitle>Sign in to Stratosonic</CardTitle>
          <CardDescription>
            Enter the username and password of your operator account
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit}>
            <FieldGroup>
              {/* A server that refuses every `/api` call (without its
                  encryption key, say) refuses the setup state as well, and
                  says why here, before anyone types. */}
              {mutation.error ? (
                <ErrorAlert error={mutation.error} />
              ) : setupState.error ? (
                <ErrorAlert error={setupState.error} />
              ) : (
                done && (
                  <Alert>
                    <CircleCheckIcon />
                    <AlertTitle>{done.title}</AlertTitle>
                    <AlertDescription>{done.description}</AlertDescription>
                  </Alert>
                )
              )}
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
                <div className="flex items-center">
                  <FieldLabel htmlFor="password">Password</FieldLabel>
                  {setupState.data === "reset-available" && (
                    <Link
                      to="/setup/reset"
                      className="ml-auto inline-block text-sm underline-offset-4 hover:underline"
                    >
                      Reset with a setup token
                    </Link>
                  )}
                </div>
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
                    No operator yet? <Link to="/setup">Set up the server</Link>
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
