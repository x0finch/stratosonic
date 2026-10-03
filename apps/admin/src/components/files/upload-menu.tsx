import { FileIcon, FolderIcon, UploadIcon } from "lucide-react";
import { type ChangeEvent, useEffect, useRef } from "react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";

/**
 * **Upload** (#83, "Layout", item 3): a menu of "Files…", which picks any
 * number of files, and "Folder…", which picks a folder with everything in
 * it (`webkitdirectory`), each file then carrying its path under the folder
 * picked (`webkitRelativePath`). The pickers are the browser's own, behind
 * two hidden inputs. While a pick is being prepared ("Preparing 2,000
 * files…", a large one) or checked against the bucket ("Checking 25
 * files…"), the button says so, with a spinner, and takes no other pick.
 */
export function UploadMenu({
  onPick,
  variant = "default",
  busy = null,
}: {
  onPick: (files: File[]) => void;
  variant?: "default" | "outline";
  /** What the pick in hand is going through, in words, or null. */
  busy?: string | null;
}) {
  const filesInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const wasBusy = useRef(false);

  useEffect(() => {
    // Not a React attribute: set on the element itself.
    if (folderInput.current) {
      folderInput.current.webkitdirectory = true;
    }
  }, []);

  // The button is disabled while busy, which drops its focus to the page:
  // once it is done, focus comes back to it, unless something else took
  // it meanwhile (the conflict dialog).
  useEffect(() => {
    if (busy !== null) {
      wasBusy.current = true;
      return;
    }
    if (wasBusy.current) {
      wasBusy.current = false;
      const active = document.activeElement;
      if (active === null || active === document.body) {
        trigger.current?.focus();
      }
    }
  }, [busy]);

  const take = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.currentTarget.files ?? []);
    // The same files can be picked again.
    event.currentTarget.value = "";
    if (files.length > 0) {
      onPick(files);
    }
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          ref={trigger}
          // The Uploads popover finds it here to give it focus back once the
          // queue empties (components/uploads-popover.tsx).
          data-upload-trigger=""
          disabled={busy !== null}
          render={<Button variant={variant} size="sm" />}
        >
          {busy !== null ? (
            <>
              <Spinner data-icon="inline-start" aria-hidden="true" />
              {busy}
            </>
          ) : (
            <>
              <UploadIcon data-icon="inline-start" />
              Upload
            </>
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => filesInput.current?.click()}>
            <FileIcon />
            Files…
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => folderInput.current?.click()}>
            <FolderIcon />
            Folder…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <input
        ref={filesInput}
        type="file"
        multiple
        hidden
        aria-label="Files to upload"
        onChange={take}
      />
      <input ref={folderInput} type="file" hidden aria-label="Folder to upload" onChange={take} />
    </>
  );
}
