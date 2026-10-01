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

  // A page of one form: the form keeps its own width, centered on both axes
  // in the shell's column, as the overview's empty state is (#113). Auto
  // margins, not justify-center: a card taller than the column then starts
  // at its top, and the inset scrolls to its bottom, instead of losing its top.
  return (
    <div className="m-auto w-full max-w-md">
      {can(me, "account:change-password") ? (
        <ChangePasswordForm username={me?.username ?? ""} />
      ) : (
        <Alert>
          <InfoIcon />
          <AlertTitle>Nothing to change here</AlertTitle>
          <AlertDescription>Your role does not let you change your password.</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
