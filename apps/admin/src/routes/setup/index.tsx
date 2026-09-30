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

/** First run (#81, #99): the setup token creates the owner account. */
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
              ? "It has an owner. Sign in, or reset the owner's password with the setup token."
              : "It has an owner. Sign in with your console account."
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
          description: "Create the owner account with the setup token",
          usernameLabel: "Username",
          passwordLabel: "Password",
          submit: "Create owner account",
          pending: "Creating owner account…",
          doneTitle: "The owner account is created",
          doneDescription: "Sign in with its username and password.",
        }}
        submit={setUp}
        footer={
          <>
            Already set up? <Link to="/login">Sign in</Link>
          </>
        }
      />
    </AuthLayout>
  );
}
