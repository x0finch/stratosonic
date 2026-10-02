import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { FolderIcon, FolderPlusIcon, InfoIcon, Trash2Icon } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

import { ErrorAlert } from "@/components/error-alert";
import { DeleteDialog } from "@/components/files/delete-dialog";
import { FilesTable } from "@/components/files/files-table";
import { FolderPath, folderSearch } from "@/components/files/folder-path";
import { NewFolderDialog } from "@/components/files/new-folder-dialog";
import { ScanLine } from "@/components/files/scan-line";
import { UploadMenu } from "@/components/files/upload-menu";
import { UploadsSection } from "@/components/files/uploads-section";
import { Section } from "@/components/section";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { useClock } from "@/hooks/use-clock";
import { useUploadQueue } from "@/hooks/use-upload-queue";
import { ApiError, type Me, meQuery } from "@/lib/api";
import {
  BUCKET_FALLBACK,
  type DeleteTarget,
  describeListing,
  filesConfigQuery,
  folderQuery,
  folderTrail,
  latestView,
  leaveFolder,
  NO_SELECTION,
  reopenFolder,
  type ScanView,
  type Selection,
  scanActive,
  selectedIn,
  selectionWhere,
  shownIds,
  toggleSelected,
  validateFilesSearch,
  viewOfLive,
  viewOfWrite,
} from "@/lib/files";
import { formatCount } from "@/lib/format";
import { liveQuery } from "@/lib/overview";
import { can } from "@/lib/roles";
import { toastError } from "@/lib/toasts";
import { planUploads } from "@/lib/uploads";

export const Route = createFileRoute("/_shell/files")({
  validateSearch: validateFilesSearch,
  component: Files,
  staticData: { title: "Files" },
});

/**
 * The Files page (#83, ticket D): the bound bucket, one folder at a time,
 * whose files and folders a role with `files:write` deletes and uploads
 * (ticket E). A folder is `?prefix=`, so it is a deep link, and the
 * browser's back button walks up.
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

/** Which dialog is open; the delete's targets stay while it closes. */
interface DialogState {
  open: "delete" | "new-folder" | null;
  targets: readonly DeleteTarget[];
}

function FilesPage({ me }: { me: Me | null }) {
  const { prefix = "" } = Route.useSearch();
  const navigate = Route.useNavigate();
  const queryClient = useQueryClient();

  const config = useQuery(filesConfigQuery);
  const folder = useInfiniteQuery(folderQuery(prefix));
  const [selection, setSelection] = useState<Selection>(NO_SELECTION);
  // Leaving a folder cuts its listing back to its first page, so that a
  // return to it once stale reads one page, not every page loaded, and
  // drops the selection with it: rows chosen on a later page are not shown
  // on return, and must not be deleted unseen.
  useEffect(
    () => () => {
      leaveFolder(queryClient, prefix);
      setSelection(NO_SELECTION);
    },
    [queryClient, prefix],
  );

  // The write controls: for a role with `files:write`, where the server
  // takes file writes (owner decision 2: not in the preview).
  const mayWrite = can(me, "files:write");
  const writable = mayWrite && config.data?.writes.enabled === true;
  const readOnlyHere = mayWrite && config.data?.writes.enabled === false;
  // Uploads, where the server can presign them too: R2 API credentials.
  const uploadable = writable && config.data?.uploads.configured === true;
  const uploadsMissing = writable && config.data?.uploads.configured === false;
  const { queue, snapshot: uploads } = useUploadQueue();
  const uploadView = uploads.schedule && viewOfWrite(uploads.schedule);

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
      scanActive(latestView(written, uploadView, query.state.data && viewOfLive(query.state.data))),
  });
  const view = latestView(written, uploadView, live.data && viewOfLive(live.data));

  const [dialog, setDialog] = useState<DialogState>({ open: null, targets: [] });
  // The folders made with New folder, which exist only once a file lands.
  const [made, setMade] = useState<ReadonlySet<string>>(new Set());

  const now = Math.max(useClock(), folder.dataUpdatedAt);
  const bucket = config.data?.bucket ?? BUCKET_FALLBACK;
  const pages = folder.data?.pages ?? [];
  const folders = pages.flatMap((page) => page.folders);
  const files = pages.flatMap((page) => page.files);
  const empty = folder.data !== undefined && folders.length === 0 && files.length === 0;
  // Only rows on screen count as selected, whatever the state holds: the
  // header's box, the Delete button's count and the delete itself all read
  // this (deletes are permanent).
  const selected = selectedIn(selection, prefix, shownIds(folder.data));
  const folderName = folderTrail(prefix).at(-1)?.name ?? bucket;

  /**
   * The picked files go into the folder on screen, each key in the deepest
   * folder the loaded listings show (lib/uploads.ts, `uploadTarget`).
   */
  function upload(picked: readonly File[]) {
    if (!config.data) {
      return;
    }
    const listed = (at: string) =>
      queryClient.getQueryData(folderQuery(at).queryKey)?.pages.flatMap((page) => page.folders);
    queue.add(planUploads(picked, prefix, config.data, listed), config.data.limits.signBatch);
  }

  function select(targets: readonly DeleteTarget[], checked: boolean) {
    setSelection((current) => toggleSelected(current, prefix, targets, checked));
  }

  function loadMore() {
    void folder.fetchNextPage().then((result) => {
      if (!result.isError) {
        return;
      }
      if (result.error instanceof ApiError && result.error.code === "invalid_cursor") {
        // R2 refused the cursor: the folder opens again from its first page.
        // The selection keeps only the rows that page shows again, so a
        // delete never takes a row that is no longer on screen.
        toastError(result.error);
        void reopenFolder(queryClient, prefix).then(() => {
          const shown = shownIds(queryClient.getQueryData(folderQuery(prefix).queryKey));
          setSelection((current) =>
            current.prefix === prefix
              ? { prefix, targets: selectionWhere(current.targets, (id) => shown.has(id)) }
              : current,
          );
        });
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
      {uploadable ? <UploadMenu onPick={upload} /> : null}
    </>
  ) : readOnlyHere ? (
    <p className="text-sm text-muted-foreground">Read-only on this deployment</p>
  ) : null;

  return (
    <div className="@container flex min-w-0 flex-col gap-4">
      <FolderPath prefix={prefix} bucket={bucket} />
      <ScanLine view={view} />
      {/* The folder has no h2: the path's current page names it. While it
          is the page's one block, it is no named region either (DESIGN.md,
          "A page with a single block has no section heading"); once the
          Uploads section joins it, it is a region named after the folder. */}
      <Section
        aria-label={uploads.items.length > 0 ? folderName : undefined}
        description={
          uploadsMissing
            ? "Uploads need R2 API credentials on the server (see the server README)."
            : // An empty folder says so in its `Empty` below, once.
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
          <FolderEmpty
            prefix={prefix}
            made={made.has(prefix)}
            upload={uploadable ? <UploadMenu variant="outline" onPick={upload} /> : null}
          />
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
      {uploads.items.length > 0 ? (
        <UploadsSection items={uploads.items} queue={queue} allowed={config.data?.allowed} />
      ) : null}
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
            onDeleted={({ reached }, schedule) => {
              if (schedule) {
                setWritten(viewOfWrite(schedule));
              }
              // Only what the delete is done with leaves the selection: a
              // delete that stopped part way leaves the rest selected.
              const done = new Set(reached);
              setSelection((current) => ({
                ...current,
                targets: selectionWhere(current.targets, (id) => !done.has(id)),
              }));
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
function FolderEmpty({
  prefix,
  made,
  upload,
}: {
  prefix: string;
  made: boolean;
  /** The Upload menu, where uploads are possible. */
  upload: ReactNode;
}) {
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
            ? upload
              ? "Upload files, or copy music into it with rclone, as the server README describes."
              : "Copy music into it with rclone, as the server README describes."
            : made
              ? "Upload files to create this folder."
              : "A folder exists only while a file is in it."}
        </EmptyDescription>
      </EmptyHeader>
      {upload ? <EmptyContent>{upload}</EmptyContent> : null}
    </Empty>
  );
}
