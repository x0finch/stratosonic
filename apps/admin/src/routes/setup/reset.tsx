import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";

import { AuthLayout } from "@/components/auth-layout";
import { SetupForm } from "@/components/setup-form";
import { SetupNotice } from "@/components/setup-notice";
import { resetConsolePassword, setupStateQuery } from "@/lib/api";

export const Route = createFileRoute("/setup/reset")({
  component: Reset,
  staticData: { title: "Reset password" },
});

/**
 * Recovery (#81, #99): an unspent setup token sets the owner's password and
 * signs the owner out everywhere. Each token value works once.
 */
function Reset() {
  const state = useQuery(setupStateQuery);

  if (state.isPending) {
    return null;
  }

  if (state.data === "needs-setup") {
    return (
      <AuthLayout>
        <SetupNotice
          heading="Reset the owner's password"
          title="There is no owner yet"
          description="Create the owner account with the setup token instead."
          links={[{ to: "/setup", label: "Set up the server" }]}
        />
      </AuthLayout>
    );
  }

  if (state.data === "closed") {
    return (
      <AuthLayout>
        <SetupNotice
          heading="Reset the owner's password"
          title="No setup token to use"
          description="The setup token is unset or already spent. Set a new one with wrangler secret put SETUP_TOKEN, then reload this page."
          links={[{ to: "/login", label: "Back to sign in" }]}
        />
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <SetupForm
        text={{
          title: "Reset the owner's password",
          description: "Set a new password with the setup token, signing the owner out everywhere",
          usernameLabel: "Owner username",
          passwordLabel: "New password",
          submit: "Reset password",
          pending: "Resetting password…",
        }}
        submit={resetConsolePassword}
        notice="reset"
        footer={
          <>
            Remembered it? <Link to="/login">Sign in</Link>
          </>
        }
      />
    </AuthLayout>
  );
}
