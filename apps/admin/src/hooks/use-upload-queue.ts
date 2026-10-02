import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";

import { completeUploads, signUploads } from "@/lib/api";
import { afterFilesChange } from "@/lib/files";
import { signOutWhenUnauthenticated } from "@/lib/sign-out";
import { toastFailure, toastSuccess } from "@/lib/toasts";
import {
  notUploadedToast,
  type QueueSnapshot,
  UploadQueue,
  uploadedToast,
  watchPage,
  xhrPut,
} from "@/lib/uploads";

/**
 * The console's one upload queue (lib/uploads.ts), made the first time the
 * Files page needs it and kept for the session, so uploads carry on while
 * the owner opens other folders or other pages. Its toasts go to the
 * root's toaster, so a run that ends on another page still says so.
 */
let shared: UploadQueue | null = null;

function createQueue(queryClient: QueryClient): UploadQueue {
  const queue = new UploadQueue(
    { sign: signUploads, complete: completeUploads, put: xhrPut },
    {
      // The folders' listings, first page only, as after a delete.
      onRefresh: () => void afterFilesChange(queryClient),
      onDrained: (summary) => {
        if (summary.uploaded > 0) {
          const { title, description } = uploadedToast(summary);
          toastSuccess(title, description);
        }
        if (summary.notUploaded > 0) {
          const { title, description } = notUploadedToast(summary);
          toastFailure(title, description);
        }
      },
      onError: (error) => signOutWhenUnauthenticated(queryClient, error),
    },
  );
  watchPage(queue, window);
  return queue;
}

export function useUploadQueue(): { queue: UploadQueue; snapshot: QueueSnapshot } {
  const queryClient = useQueryClient();
  shared ??= createQueue(queryClient);
  const snapshot = useSyncExternalStore(shared.subscribe, shared.getSnapshot);
  return { queue: shared, snapshot };
}
