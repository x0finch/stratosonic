import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";

import { AuthLayout } from "@/components/auth-layout";
import { SetupForm } from "@/components/setup-form";
import { SetupNotice } from "@/components/setup-notice";
import { setUp, setupStateQuery } from "@/lib/api";

export const Route = createFileRoute("/setup/")({
  component: Setup,
  staticData: { title: "Set up" },
});

/** First run (#81): the setup token creates the first admin. */
function Setup() {
  const state = useQuery(setupStateQuery);

  if (state.isPending) {
    return null;
  }

  // Unknown or unreadable, the form stays: the server has the last word.
  if (state.data === "closed" || state.data === "reset-available") {
    return (
      <AuthLayout>
        <SetupNotice
          heading="Set up Stratosonic"
          title="The server is already set up"
          description={
            state.data === "reset-available"
              ? "It has an admin. Sign in, or reset an admin's password with the setup token."
              : "It has an admin. Sign in with the admin's username and password."
          }
          links={
            state.data === "reset-available"
              ? [
                  { to: "/login", label: "Sign in" },
                  { to: "/setup/reset", label: "Reset a password" },
                ]
              : [{ to: "/login", label: "Sign in" }]
          }
        />
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <SetupForm
        text={{
          title: "Set up Stratosonic",
          description: "Create the admin with the setup token",
          usernameLabel: "Username",
          passwordLabel: "Password",
          submit: "Create admin",
          pending: "Creating admin…",
        }}
        submit={setUp}
        notice="set-up"
        footer={
          <>
            Already set up? <Link to="/login">Sign in</Link>
          </>
        }
      />
    </AuthLayout>
  );
}
