import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";

import { AuthLayout } from "@/components/auth-layout";
import { SetupForm } from "@/components/setup-form";
import { SetupNotice } from "@/components/setup-notice";
import { resetAdminPassword, setupStateQuery } from "@/lib/api";

export const Route = createFileRoute("/setup/reset")({
  component: Reset,
  staticData: { title: "Reset password" },
});

/**
 * Recovery (#81): an unspent setup token sets an admin's password and signs
 * that admin out everywhere. Each token value works once.
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
          heading="Reset an admin password"
          title="There is no admin yet"
          description="Create the first admin with the setup token instead."
          links={[{ to: "/setup", label: "Set up the server" }]}
        />
      </AuthLayout>
    );
  }

  if (state.data === "closed") {
    return (
      <AuthLayout>
        <SetupNotice
          heading="Reset an admin password"
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
          title: "Reset an admin password",
          description: "Set a new password with the setup token, signing the admin out everywhere",
          usernameLabel: "Admin username",
          passwordLabel: "New password",
          submit: "Reset password",
          pending: "Resetting password…",
        }}
        submit={resetAdminPassword}
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
