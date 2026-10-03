import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { FolderIcon, FolderPlusIcon, InfoIcon, Trash2Icon } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

import { ErrorAlert } from "@/components/error-alert";
import { ConflictDialog } from "@/components/files/conflict-dialog";
import { DeleteDialog } from "@/components/files/delete-dialog";
import { FilesTable } from "@/components/files/files-table";
import { FolderPath, folderSearch } from "@/components/files/folder-path";
import { NewFolderDialog } from "@/components/files/new-folder-dialog";
import { ScanLine } from "@/components/files/scan-line";
import { UploadMenu } from "@/components/files/upload-menu";
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
import { useUploadQueue, useUploads } from "@/hooks/use-upload-queue";
import { ApiError, checkUploads, type Me, meQuery } from "@/lib/api";
import {
  BUCKET_FALLBACK,
  countOf,
  type DeleteTarget,
  describeListing,
  filesConfigQuery,
  folderQuery,
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
import { signOutWhenUnauthenticated } from "@/lib/sign-out";
import { toastError, toastFailure } from "@/lib/toasts";
import {
  type ConflictDecision,
  decideConflicts,
  findConflicts,
  PLAN_SLICE,
  type PlannedUpload,
  planUploads,
  planUploadsInSlices,
  type UploadConflict,
} from "@/lib/uploads";

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

/** A pick with conflicts, and what the conflict dialog says of it. */
interface AskingState {
  open: boolean;
  planned: readonly PlannedUpload[];
  conflicts: readonly UploadConflict[];
  /** The files checked: the pick less what the mirror refused. */
  checked: number;
  /** The folder the pick went into, which every key starts with. */
  folder: string;
}

function FilesPage({ me }: { me: Me | null }) {
  const { prefix = "" } = Route.useSearch();
  const navigate = Route.useNavigate();
  const queryClient = useQueryClient();

  // The page reads only while signed in. Signing out clears the cache
  // while the page is still on screen, until the sign-in screen replaces
  // it (lib/sign-out.ts, `leaveSignedOut`): any redraw then, such as the
  // upload queue ending, would build these queries again and read them
  // without a session, two 401s (#141). The session is read here, not
  // from `me`, which such a redraw does not renew.
  const { data: session } = useQuery(meQuery);
  const signedIn = session != null;
  const config = useQuery({ ...filesConfigQuery, enabled: signedIn });
  const folder = useInfiniteQuery({ ...folderQuery(prefix), enabled: signedIn });
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
  // The page redraws for the queue only when a completion brings a new
  // schedule; the rows are the header's Uploads popover's own.
  const queue = useUploadQueue();
  const uploadSchedule = useUploads(queue, (snapshot) => snapshot.schedule);
  const uploadView = uploadSchedule && viewOfWrite(uploadSchedule);

  // The scan line: the last write's schedule, or the live route's, whichever
  // came last. The live route is read only while a pass is scheduled or
  // running, and only with `library:read`; it polls at the Overview's pace,
  // and not at all in a hidden tab.
  const [written, setWritten] = useState<ScanView | undefined>();
  const canReadLibrary = can(me, "library:read");
  const live = useQuery({
    ...liveQuery,
    enabled: (query) =>
      signedIn &&
      canReadLibrary &&
      scanActive(latestView(written, uploadView, query.state.data && viewOfLive(query.state.data))),
  });
  const view = latestView(written, uploadView, live.data && viewOfLive(live.data));

  const [dialog, setDialog] = useState<DialogState>({ open: null, targets: [] });
  // The folders made with New folder, which exist only once a file lands.
  const [made, setMade] = useState<ReadonlySet<string>>(new Set());
  // What the pick in hand is going through, in the Upload button's words:
  // "Preparing 2,000 files…" (a large pick), "Checking 25 files…", or null.
  const [busy, setBusy] = useState<string | null>(null);
  // A pick with conflicts, waiting for the owner's one answer; it stays
  // while the dialog closes.
  const [asking, setAsking] = useState<AskingState>({
    open: false,
    planned: [],
    conflicts: [],
    checked: 0,
    folder: "",
  });

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

  /**
   * The picked files go into the folder on screen, each key in the deepest
   * folder the loaded listings show (lib/uploads.ts, `uploadTarget`). They
   * are checked against the bucket first (#141): a pick with no conflict
   * goes at once, and one with conflicts asks once, in the conflict dialog.
   */
  async function upload(picked: readonly File[]) {
    const settings = config.data;
    if (!settings) {
      return;
    }
    const listed = (at: string) =>
      queryClient.getQueryData(folderQuery(at).queryKey)?.pages.flatMap((page) => page.folders);
    let planned: PlannedUpload[];
    if (picked.length > PLAN_SLICE) {
      // A large pick is prepared in slices, with the button saying so.
      setBusy(`Preparing ${countOf(picked.length, "file")}…`);
      try {
        planned = await planUploadsInSlices(picked, prefix, settings, listed);
      } finally {
        setBusy(null);
      }
    } else {
      planned = planUploads(picked, prefix, settings, listed);
    }
    if (planned.length === 0) {
      // A folder pick of hidden files only, such as a folder whose name
      // starts with a dot: say so rather than do nothing.
      toastFailure(
        "Nothing to upload",
        "Hidden files and folders, whose names start with a dot, are not uploaded.",
      );
      return;
    }

    // The files the mirror took are checked; the refused ones fail in the
    // list without a request.
    const checked = planned.filter((upload) => upload.refusal === null).length;
    let conflicts: UploadConflict[] = [];
    if (checked > 0) {
      setBusy(`Checking ${countOf(checked, "file")}…`);
      try {
        conflicts = await findConflicts(planned, checkUploads);
      } catch (error) {
        // Nothing is uploaded without the check: the owner picks again.
        if (!signOutWhenUnauthenticated(queryClient, error)) {
          toastError(error, "The files could not be checked");
        }
        return;
      } finally {
        setBusy(null);
      }
    }
    if (conflicts.length === 0) {
      queue.add(planned, settings.limits.signBatch);
      return;
    }
    setAsking({ open: true, planned, conflicts, checked, folder: prefix });
  }

  /** The owner's one answer to the conflict dialog: what goes, if anything. */
  function decide(decision: ConflictDecision) {
    if (!asking.open || !config.data) {
      return;
    }
    setAsking((state) => ({ ...state, open: false }));
    const going = decideConflicts(asking.planned, asking.conflicts, decision);
    if (going.length > 0) {
      queue.add(going, config.data.limits.signBatch);
    }
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
      {uploadable ? <UploadMenu onPick={(files) => void upload(files)} busy={busy} /> : null}
    </>
  ) : readOnlyHere ? (
    <p className="text-sm text-muted-foreground">Read-only on this deployment</p>
  ) : null;

  return (
    <div className="@container flex min-w-0 flex-col gap-4">
      <FolderPath prefix={prefix} bucket={bucket} />
      <ScanLine view={view} />
      {/* The folder is the page's one block: it has no h2, since the path's
          current page names it, and is no named region (DESIGN.md, "A page
          with a single block has no section heading"). The upload list is
          the header's (components/uploads-popover.tsx). */}
      <Section
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
            upload={
              uploadable ? (
                <UploadMenu variant="outline" onPick={(files) => void upload(files)} busy={busy} />
              ) : null
            }
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
          <ConflictDialog
            open={asking.open}
            conflicts={asking.conflicts}
            total={asking.checked}
            folder={asking.folder}
            onDecide={decide}
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
