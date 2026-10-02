import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { FolderIcon, FolderPlusIcon, InfoIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import { ErrorAlert } from "@/components/error-alert";
import { DeleteDialog } from "@/components/files/delete-dialog";
import { FilesTable } from "@/components/files/files-table";
import { FolderPath, folderSearch } from "@/components/files/folder-path";
import { NewFolderDialog } from "@/components/files/new-folder-dialog";
import { ScanLine } from "@/components/files/scan-line";
import { Section } from "@/components/section";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { useClock } from "@/hooks/use-clock";
import { ApiError, type Me, meQuery } from "@/lib/api";
import {
  BUCKET_FALLBACK,
  type DeleteTarget,
  describeListing,
  filesConfigQuery,
  folderQuery,
  folderTitle,
  latestView,
  reopenFolder,
  type ScanView,
  scanActive,
  targetId,
  validateFilesSearch,
  viewOfLive,
  viewOfWrite,
} from "@/lib/files";
import { formatCount } from "@/lib/format";
import { liveQuery } from "@/lib/overview";
import { can } from "@/lib/roles";
import { toastError } from "@/lib/toasts";

export const Route = createFileRoute("/_shell/files")({
  validateSearch: validateFilesSearch,
  component: Files,
  staticData: { title: "Files" },
});

/**
 * The Files page (#83, ticket D): the bound bucket, one folder at a time,
 * whose files and folders a role with `files:write` deletes. A folder is
 * `?prefix=`, so it is a deep link, and the browser's back button walks up.
 * Uploads are ticket E.
 */
function Files() {
  const { data: me } = useQuery(meQuery);

  if (!can(me, "files:read")) {
    return (
      <div className="mx-auto w-full max-w-md">
        <Alert>
          <InfoIcon />
          <AlertTitle>Nothing to see here</AlertTitle>
          <AlertDescription>Your role does not let you see the files.</AlertDescription>
        </Alert>
      </div>
    );
  }

  return <FilesPage me={me ?? null} />;
}

/** The selected rows, for the folder they were chosen in. */
interface Selection {
  prefix: string;
  targets: ReadonlyMap<string, DeleteTarget>;
}

/** Which dialog is open; the delete's targets stay while it closes. */
interface DialogState {
  open: "delete" | "new-folder" | null;
  targets: readonly DeleteTarget[];
}

const NO_SELECTION: ReadonlyMap<string, DeleteTarget> = new Map();

function FilesPage({ me }: { me: Me | null }) {
  const { prefix = "" } = Route.useSearch();
  const navigate = Route.useNavigate();
  const queryClient = useQueryClient();

  const config = useQuery(filesConfigQuery);
  const folder = useInfiniteQuery(folderQuery(prefix));

  // The write controls: for a role with `files:write`, where the server
  // takes file writes (owner decision 2: not in the preview).
  const mayWrite = can(me, "files:write");
  const writable = mayWrite && config.data?.writes.enabled === true;
  const readOnlyHere = mayWrite && config.data?.writes.enabled === false;

  // The scan line: the last write's schedule, or the live route's, whichever
  // came last. The live route is read only while a pass is scheduled or
  // running, and only with `library:read`; it polls at the Overview's pace,
  // and not at all in a hidden tab.
  const [written, setWritten] = useState<ScanView | undefined>();
  const canReadLibrary = can(me, "library:read");
  const live = useQuery({
    ...liveQuery,
    enabled: (query) =>
      canReadLibrary &&
      scanActive(latestView(written, query.state.data && viewOfLive(query.state.data))),
  });
  const view = latestView(written, live.data && viewOfLive(live.data));

  const [selection, setSelection] = useState<Selection>({ prefix, targets: NO_SELECTION });
  const selected = selection.prefix === prefix ? selection.targets : NO_SELECTION;
  const [dialog, setDialog] = useState<DialogState>({ open: null, targets: [] });
  // The folders made with New folder, which exist only once a file lands.
  const [made, setMade] = useState<ReadonlySet<string>>(new Set());

  const now = Math.max(useClock(), folder.dataUpdatedAt);
  const bucket = config.data?.bucket ?? BUCKET_FALLBACK;
  const pages = folder.data?.pages ?? [];
  const folders = pages.flatMap((page) => page.folders);
  const files = pages.flatMap((page) => page.files);
  const empty = folder.data !== undefined && folders.length === 0 && files.length === 0;

  function select(targets: readonly DeleteTarget[], checked: boolean) {
    setSelection((current) => {
      const next = new Map(current.prefix === prefix ? current.targets : NO_SELECTION);
      for (const target of targets) {
        if (checked) {
          next.set(targetId(target), target);
        } else {
          next.delete(targetId(target));
        }
      }
      return { prefix, targets: next };
    });
  }

  function loadMore() {
    void folder.fetchNextPage().then((result) => {
      if (!result.isError) {
        return;
      }
      if (result.error instanceof ApiError && result.error.code === "invalid_cursor") {
        // R2 refused the cursor: the folder opens again from its first page.
        toastError(result.error);
        void reopenFolder(queryClient, prefix);
      } else {
        toastError(result.error, "The next page could not be read");
      }
    });
  }

  const openDialog = (open: DialogState["open"], targets: readonly DeleteTarget[] = []) =>
    setDialog({ open, targets });
  const closeOf = (which: NonNullable<DialogState["open"]>) => (open: boolean) => {
    if (!open) {
      setDialog((state) => (state.open === which ? { ...state, open: null } : state));
    }
  };

  const actions = writable ? (
    <>
      {selected.size > 0 ? (
        <Button
          variant="destructive"
          size="sm"
          onClick={() => openDialog("delete", [...selected.values()])}
        >
          <Trash2Icon data-icon="inline-start" />
          Delete {formatCount(selected.size)} selected
        </Button>
      ) : null}
      <Button variant="outline" size="sm" onClick={() => openDialog("new-folder")}>
        <FolderPlusIcon data-icon="inline-start" />
        New folder
      </Button>
    </>
  ) : readOnlyHere ? (
    <p className="text-sm text-muted-foreground">Read-only on this deployment</p>
  ) : null;

  return (
    <div className="@container flex min-w-0 flex-col gap-4">
      <FolderPath prefix={prefix} bucket={bucket} />
      <ScanLine view={view} />
      <Section
        title={folderTitle(prefix, bucket)}
        description={
          // An empty folder says so in its `Empty` below, once.
          empty
            ? undefined
            : folder.data
              ? describeListing(folders.length, files.length, folder.hasNextPage)
              : folder.isPending
                ? "Reading the folder…"
                : undefined
        }
        action={actions}
      >
        {folder.isPending ? (
          <div className="flex flex-col gap-2" aria-busy="true">
            <span className="sr-only">Loading the folder…</span>
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : folder.data === undefined ? (
          <ErrorAlert error={folder.error} />
        ) : empty ? (
          <FolderEmpty prefix={prefix} made={made.has(prefix)} />
        ) : (
          <>
            <FilesTable
              folders={folders}
              files={files}
              now={now}
              actions={
                writable
                  ? {
                      selected,
                      onSelect: select,
                      onDelete: (target) => openDialog("delete", [target]),
                    }
                  : undefined
              }
            />
            {folder.hasNextPage ? (
              <div className="flex justify-center">
                <Button variant="outline" disabled={folder.isFetchingNextPage} onClick={loadMore}>
                  {folder.isFetchingNextPage ? (
                    <Spinner data-icon="inline-start" aria-hidden="true" />
                  ) : null}
                  Load more
                </Button>
              </div>
            ) : null}
          </>
        )}
      </Section>
      {writable && config.data ? (
        <>
          <NewFolderDialog
            open={dialog.open === "new-folder"}
            onOpenChange={closeOf("new-folder")}
            prefix={prefix}
            limits={config.data.limits}
            onCreate={(next) => {
              setMade((current) => new Set(current).add(next));
              void navigate({ search: folderSearch(next) });
            }}
          />
          <DeleteDialog
            targets={dialog.targets}
            open={dialog.open === "delete"}
            onOpenChange={closeOf("delete")}
            batch={config.data.limits.deleteBatch}
            rescanQuietSeconds={config.data.rescanQuietSeconds}
            onDeleted={(_, schedule) => {
              if (schedule) {
                setWritten(viewOfWrite(schedule));
              }
              setSelection({ prefix, targets: NO_SELECTION });
            }}
          />
        </>
      ) : null}
    </div>
  );
}

/**
 * An empty folder, in the official `Empty`. R2 has no folders, so a folder
 * with nothing in it exists only on this page: one just made with New
 * folder, until a file lands, or one whose files are gone.
 */
function FolderEmpty({ prefix, made }: { prefix: string; made: boolean }) {
  const root = prefix === "";
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <FolderIcon />
        </EmptyMedia>
        <EmptyTitle>{root ? "The bucket is empty" : "This folder is empty"}</EmptyTitle>
        <EmptyDescription>
          {root
            ? "Copy music into it with rclone, as the server README describes."
            : made
              ? "Upload files to create this folder."
              : "A folder exists only while a file is in it."}
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
