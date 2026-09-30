import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { InfoIcon } from "lucide-react";

import { ChangePasswordForm } from "@/components/change-password-form";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { meQuery } from "@/lib/api";
import { can } from "@/lib/roles";

export const Route = createFileRoute("/_shell/account")({
  component: Account,
  staticData: { title: "Account" },
});

/**
 * The signed-in console user's own account: for now, its password, which
 * only a role that grants `account:change-password` may change.
 */
function Account() {
  const { data: me } = useQuery(meQuery);

  return (
    <div className="px-4 lg:px-6">
      {can(me, "account:change-password") ? (
        <ChangePasswordForm className="max-w-md" username={me?.username ?? ""} />
      ) : (
        <Alert className="max-w-md">
          <InfoIcon />
          <AlertTitle>Nothing to change here</AlertTitle>
          <AlertDescription>Your role does not let you change your password.</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
