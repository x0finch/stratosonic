import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

import { ChangePasswordForm } from "@/components/change-password-form";
import { meQuery } from "@/lib/api";

export const Route = createFileRoute("/_shell/account")({
  component: Account,
  staticData: { title: "Account" },
});

/** The signed-in user's own account: for now, its password. */
function Account() {
  const { data: me } = useQuery(meQuery);

  return (
    <div className="px-4 lg:px-6">
      <ChangePasswordForm className="max-w-md" userName={me?.userName ?? ""} />
    </div>
  );
}
