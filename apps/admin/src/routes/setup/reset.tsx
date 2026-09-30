import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";

import { AuthLayout } from "@/components/auth-layout";
import { SetupForm } from "@/components/setup-form";
import { SetupNotice } from "@/components/setup-notice";
import { resetOperatorPassword, setupStateQuery } from "@/lib/api";

export const Route = createFileRoute("/setup/reset")({
  component: Reset,
  staticData: { title: "Reset password" },
});

/**
 * Recovery (#81, #99): an unspent setup token sets an operator's password and
 * signs that operator out everywhere. Each token value works once.
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
          heading="Reset an operator's password"
          title="There is no operator yet"
          description="Create the first operator account with the setup token instead."
          links={[{ to: "/setup", label: "Set up the server" }]}
        />
      </AuthLayout>
    );
  }

  if (state.data === "closed") {
    return (
      <AuthLayout>
        <SetupNotice
          heading="Reset an operator's password"
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
          title: "Reset an operator's password",
          description:
            "Set a new password with the setup token, signing the operator out everywhere",
          usernameLabel: "Operator username",
          passwordLabel: "New password",
          submit: "Reset password",
          pending: "Resetting password…",
        }}
        submit={resetOperatorPassword}
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
