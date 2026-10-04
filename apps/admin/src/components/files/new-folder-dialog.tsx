import { type FormEvent, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { FilesConfig } from "@/lib/api";
import { checkFolderName } from "@/lib/files";

/**
 * New folder (#83, "Folders"): a name, checked here with the server's rules
 * for a segment of a new key, and the page opens the folder it names. R2
 * has no folders, so nothing is written: the folder exists once a file is
 * uploaded into it. A refused name stays beside the field, and goes as soon
 * as the name changes.
 */
export function NewFolderDialog({
  open,
  onOpenChange,
  prefix,
  limits,
  reserved,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  prefix: string;
  limits: FilesConfig["limits"];
  /** The library's reserved prefixes (library 1's `_covers/`). */
  reserved: readonly string[];
  onCreate: (prefix: string) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        {/* The popup unmounts once closed: each opening starts from an empty name. */}
        <NewFolderForm
          prefix={prefix}
          limits={limits}
          reserved={reserved}
          onCreate={(folder) => {
            onOpenChange(false);
            onCreate(folder);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

function NewFolderForm({
  prefix,
  limits,
  reserved,
  onCreate,
}: {
  prefix: string;
  limits: FilesConfig["limits"];
  reserved: readonly string[];
  onCreate: (prefix: string) => void;
}) {
  const [error, setError] = useState<string | undefined>();

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const checked = checkFolderName(
      String(new FormData(event.currentTarget).get("name") ?? ""),
      prefix,
      limits,
      reserved,
    );
    if ("error" in checked) {
      setError(checked.error);
      return;
    }
    onCreate(checked.prefix);
  }

  return (
    <form onSubmit={onSubmit} onChange={() => setError(undefined)} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>New folder</DialogTitle>
        <DialogDescription>
          The new folder opens empty. It is kept once a file is uploaded into it.
        </DialogDescription>
      </DialogHeader>
      <FieldGroup>
        <Field data-invalid={error ? true : undefined}>
          <FieldLabel htmlFor="folder-name">Name</FieldLabel>
          <Input
            id="folder-name"
            name="name"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={error ? true : undefined}
            required
          />
          {error ? <FieldError>{error}</FieldError> : null}
        </Field>
      </FieldGroup>
      <DialogFooter>
        <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
        <Button type="submit">Create folder</Button>
      </DialogFooter>
    </form>
  );
}
