import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

import { AuthLayout } from "@/components/auth-layout";
import { SetupForm } from "@/components/setup-form";
import { SetupNotice } from "@/components/setup-notice";
import { setupStateQuery } from "@/lib/api";

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
  if (state.data === "closed") {
    return (
      <AuthLayout>
        <SetupNotice
          heading="Set up Stratosonic"
          title="The server is already set up"
          description="It has an owner. Sign in with your console account."
          links={[{ to: "/login", label: "Sign in" }]}
        />
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <SetupForm />
    </AuthLayout>
  );
}
