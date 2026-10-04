import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { InfoIcon, PlusIcon } from "lucide-react";
import { useState } from "react";

import { ErrorAlert } from "@/components/error-alert";
import { ConnectDialog } from "@/components/libraries/connect-dialog";
import { CorsDialog } from "@/components/libraries/cors-dialog";
import { EditDialog } from "@/components/libraries/edit-dialog";
import { LibrariesTable, type LibraryAction } from "@/components/libraries/libraries-table";
import { useLibraryWrite } from "@/components/libraries/library-form";
import { RemoveDialog } from "@/components/libraries/remove-dialog";
import { Section } from "@/components/section";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useClock } from "@/hooks/use-clock";
import { type Library, meQuery, testLibrary } from "@/lib/api";
import { type LibraryNotice, librariesQuery, testNotice } from "@/lib/libraries";
import { can } from "@/lib/roles";

export const Route = createFileRoute("/_shell/libraries")({
  component: Libraries,
  staticData: { title: "Libraries" },
});

/** Which dialog is open, and for which library. The library stays while a dialog closes. */
interface DialogState {
  open: "connect" | Exclude<LibraryAction, "test"> | null;
  library: Library | null;
  /** What a connect did, which the Bucket CORS dialog it opens repeats. */
  connected: LibraryNotice | null;
}

/**
 * The libraries (#84, "Console"): the buckets this server serves, library 1
 * being the one the Worker is bound to. A role with `libraries:read` sees
 * them and each bucket's CORS rule; one with `libraries:write` also
 * connects a bucket, edits, tests and removes one. The server checks both
 * on every route regardless.
 */
function Libraries() {
  const { data: me } = useQuery(meQuery);
  const readable = can(me, "libraries:read");
  const writable = can(me, "libraries:write");
  const libraries = useQuery({ ...librariesQuery, enabled: readable });
  const [dialog, setDialog] = useState<DialogState>({
    open: null,
    library: null,
    connected: null,
  });
  // What "2 minutes ago" is measured from: this browser's clock, which moves
  // on once a minute, or the latest read of the list, should that be later.
  const now = Math.max(useClock(), libraries.dataUpdatedAt);

  const test = useLibraryWrite({
    mutationFn: (library: Library) => testLibrary(library.id),
    succeeded: (result, library) => testNotice(library, result),
  });

  if (!readable) {
    return (
      <div className="mx-auto w-full max-w-md">
        <Alert>
          <InfoIcon />
          <AlertTitle>Nothing to see here</AlertTitle>
          <AlertDescription>Your role does not let you see the libraries.</AlertDescription>
        </Alert>
      </div>
    );
  }

  // Each dialog closes only itself: a late answer to a write from one dialog
  // must not close another the owner has opened since.
  const closeOf = (which: NonNullable<DialogState["open"]>) => (open: boolean) => {
    if (!open) {
      setDialog((state) => (state.open === which ? { ...state, open: null } : state));
    }
  };
  const onAction = (action: LibraryAction, library: Library) => {
    if (action === "test") {
      test.mutate(library);
    } else {
      setDialog({ open: action, library, connected: null });
    }
  };

  return (
    <>
      {/* The page is this one block, which the header's h1 names, so it has
          no heading of its own (DESIGN.md). */}
      <Section
        description="Buckets this server serves as libraries. Library 1 is the bucket the Worker is bound to."
        action={
          writable && libraries.isSuccess ? (
            <Button
              size="sm"
              onClick={() => setDialog({ open: "connect", library: null, connected: null })}
            >
              <PlusIcon data-icon="inline-start" />
              Connect bucket
            </Button>
          ) : null
        }
      >
        {libraries.isPending ? (
          <div className="flex flex-col gap-2" aria-busy="true">
            <span className="sr-only">Loading the libraries…</span>
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : libraries.isError ? (
          <ErrorAlert error={libraries.error} />
        ) : (
          <LibrariesTable
            libraries={libraries.data.libraries}
            now={now}
            writable={writable}
            onAction={onAction}
          />
        )}
      </Section>
      <CorsDialog
        library={dialog.library}
        connected={dialog.connected}
        open={dialog.open === "cors"}
        onOpenChange={closeOf("cors")}
      />
      {writable && (
        <>
          <ConnectDialog
            open={dialog.open === "connect"}
            onOpenChange={closeOf("connect")}
            defaultAccountId={libraries.data?.defaultAccountId ?? null}
            onConnected={(library, connected) => setDialog({ open: "cors", library, connected })}
          />
          <EditDialog
            library={dialog.library}
            open={dialog.open === "edit"}
            onOpenChange={closeOf("edit")}
          />
          <RemoveDialog
            library={dialog.library}
            open={dialog.open === "remove"}
            onOpenChange={closeOf("remove")}
          />
        </>
      )}
    </>
  );
}
