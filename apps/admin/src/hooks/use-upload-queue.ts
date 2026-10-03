import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";

import { completeUploads, signUploads } from "@/lib/api";
import { afterUploadsLanded } from "@/lib/files";
import { signOutWhenUnauthenticated, whenSignedOut } from "@/lib/sign-out";
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
 * shell needs it (the header's Uploads trigger, components/uploads-popover.tsx)
 * and kept for the session, so uploads carry on while the owner opens
 * other folders or other pages, and the trigger shows them on every page.
 * Only the Files page adds files to it. Its toasts go to the
 * root's toaster, so a run that ends on another page still says so. It
 * ends with the session (lib/sign-out.ts, `whenSignedOut`): what is still
 * to go is canceled, every row goes, and the next session starts a new one.
 */
let shared: UploadQueue | null = null;

function createQueue(queryClient: QueryClient): UploadQueue {
  const queue = new UploadQueue(
    { sign: signUploads, complete: completeUploads, put: xhrPut },
    {
      // Only the folders the landed keys change, each from its first page.
      onRefresh: (keys) => void afterUploadsLanded(queryClient, keys),
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
  const stopWatching = watchPage(queue, window);
  const stopListening = whenSignedOut(() => {
    stopListening();
    stopWatching();
    queue.dispose();
    if (shared === queue) {
      shared = null;
    }
  });
  return queue;
}

/** The session's upload queue. */
export function useUploadQueue(): UploadQueue {
  const queryClient = useQueryClient();
  shared ??= createQueue(queryClient);
  return shared;
}

/**
 * One part of the queue's snapshot, such as whether it holds a file: the
 * component redraws only when that part changes, not on every upload's
 * progress.
 */
export function useUploads<T>(queue: UploadQueue, select: (snapshot: QueueSnapshot) => T): T {
  return useSyncExternalStore(queue.subscribe, () => select(queue.getSnapshot()));
}
