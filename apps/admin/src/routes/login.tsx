import { createFileRoute, redirect } from "@tanstack/react-router";

import { AuthLayout } from "@/components/auth-layout";
import { LoginForm } from "@/components/login-form";
import { meQuery } from "@/lib/api";
import { safeRedirect } from "@/lib/redirect";

interface LoginSearch {
  /** The console page to return to once signed in. */
  redirect?: string;
}

export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>): LoginSearch => ({
    ...(typeof search.redirect === "string" && { redirect: search.redirect }),
  }),
  // Already signed in: straight on to where the sign-in would lead. A server
  // that cannot say is left to the form, which shows why.
  beforeLoad: async ({ context, search }) => {
    const me = await context.queryClient.ensureQueryData(meQuery).catch(() => null);
    if (me) {
      throw redirect({ href: safeRedirect(search.redirect), replace: true });
    }
  },
  component: Login,
  staticData: { title: "Sign in" },
});

function Login() {
  const { redirect: target } = Route.useSearch();

  return (
    <AuthLayout>
      <LoginForm redirectTo={safeRedirect(target)} />
    </AuthLayout>
  );
}
