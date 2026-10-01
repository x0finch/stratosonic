import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { InfoIcon, PlusIcon, UsersIcon } from "lucide-react";
import { useState } from "react";

import { ErrorAlert } from "@/components/error-alert";
import { CreateUserDialog } from "@/components/subsonic-users/create-user-dialog";
import { DeleteUserDialog } from "@/components/subsonic-users/delete-user-dialog";
import { EditUserDialog } from "@/components/subsonic-users/edit-user-dialog";
import { SetPasswordDialog } from "@/components/subsonic-users/set-password-dialog";
import { type UserAction, UsersTable } from "@/components/subsonic-users/users-table";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { meQuery, type SubsonicUser, subsonicUsersQuery } from "@/lib/api";
import { can } from "@/lib/roles";
import { adminRequired } from "@/lib/subsonic-users";

export const Route = createFileRoute("/_shell/users")({
  component: SubsonicUsers,
  staticData: { title: "Subsonic users" },
});

/** Which dialog is open, and for whom. The user stays while a dialog closes. */
interface DialogState {
  open: "create" | UserAction | null;
  user: SubsonicUser | null;
}

/**
 * The Subsonic users (#82): the accounts Subsonic clients sign in with,
 * which never sign in to the console. A role with `subsonic-users:read`
 * sees them; one with `subsonic-users:write` also adds, edits, sets
 * passwords and deletes. The server checks both on every route regardless.
 */
function SubsonicUsers() {
  const { data: me } = useQuery(meQuery);
  const readable = can(me, "subsonic-users:read");
  const writable = can(me, "subsonic-users:write");
  const users = useQuery({ ...subsonicUsersQuery, enabled: readable });
  const [dialog, setDialog] = useState<DialogState>({ open: null, user: null });

  if (!readable) {
    return (
      <div className="m-auto w-full max-w-md">
        <Alert>
          <InfoIcon />
          <AlertTitle>Nothing to see here</AlertTitle>
          <AlertDescription>Your role does not let you see the Subsonic users.</AlertDescription>
        </Alert>
      </div>
    );
  }

  const list = users.data ?? [];
  const close = (open: boolean) => {
    if (!open) {
      setDialog((state) => ({ ...state, open: null }));
    }
  };
  const openFor = (action: DialogState["open"], user: SubsonicUser | null) =>
    setDialog({ open: action, user });

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Subsonic users</CardTitle>
          <CardDescription>
            The accounts Subsonic clients, such as Substreamer, sign in with. They never sign in to
            this console.
          </CardDescription>
          {writable && users.isSuccess && (
            <CardAction>
              <Button onClick={() => openFor("create", null)}>
                <PlusIcon />
                Add user
              </Button>
            </CardAction>
          )}
        </CardHeader>
        <CardContent>
          {users.isPending ? (
            <div className="flex flex-col gap-2" aria-busy="true">
              <span className="sr-only">Loading the Subsonic users…</span>
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          ) : users.isError ? (
            <ErrorAlert error={users.error} />
          ) : list.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <UsersIcon />
                </EmptyMedia>
                <EmptyTitle>No Subsonic users yet</EmptyTitle>
                <EmptyDescription>
                  Add the first one to sign in from a Subsonic client. It is a Subsonic admin, as
                  library scans and the playlist import need one.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <UsersTable users={list} onAction={writable ? openFor : undefined} />
          )}
        </CardContent>
      </Card>
      {writable && (
        <>
          <CreateUserDialog
            open={dialog.open === "create"}
            onOpenChange={close}
            adminRequired={adminRequired(list)}
          />
          <EditUserDialog user={dialog.user} open={dialog.open === "edit"} onOpenChange={close} />
          <SetPasswordDialog
            user={dialog.user}
            open={dialog.open === "password"}
            onOpenChange={close}
          />
          <DeleteUserDialog
            user={dialog.user}
            open={dialog.open === "delete"}
            onOpenChange={close}
          />
        </>
      )}
    </>
  );
}
