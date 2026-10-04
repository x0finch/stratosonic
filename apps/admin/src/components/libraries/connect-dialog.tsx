import { type FormEvent, useState } from "react";

import {
  BucketFields,
  DefaultNewUsersField,
  KeyFields,
  NameField,
  useLibraryFieldErrors,
  useLibraryWrite,
} from "@/components/libraries/library-form";
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
import { FieldGroup } from "@/components/ui/field";
import { connectLibrary, type Library, type NewLibrary } from "@/lib/api";
import { connectedNotice, type LibraryField, type LibraryNotice } from "@/lib/libraries";

/** Every field of the connect form, so each refusal of the five codes shows beside one. */
const FIELDS: readonly LibraryField[] = [
  "name",
  "accountId",
  "bucket",
  "accessKeyId",
  "secretAccessKey",
];

/**
 * Connects another R2 bucket as a library (#84): its name, the account and
 * the bucket, and an R2 API token's keys. The server tests the token before
 * it stores anything, and a refusal that belongs to a field (`name_taken`,
 * `invalid_account_id`, `invalid_bucket`, `already_connected`, and a key
 * refused or a bucket not found by the test) stays beside it. Once
 * connected, the toast says its first scan has started, and `onConnected`
 * opens the bucket's CORS rule.
 */
export function ConnectDialog({
  open,
  onOpenChange,
  defaultAccountId,
  onConnected,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultAccountId: string | null;
  onConnected: (library: Library, notice: LibraryNotice) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* A form taller than a phone's screen scrolls inside the dialog. */}
      <DialogContent className="max-h-svh overflow-y-auto">
        {/* The popup unmounts once closed: each opening starts from empty fields. */}
        <ConnectForm
          defaultAccountId={defaultAccountId}
          onDone={() => onOpenChange(false)}
          onConnected={onConnected}
        />
      </DialogContent>
    </Dialog>
  );
}

function ConnectForm({
  defaultAccountId,
  onDone,
  onConnected,
}: {
  defaultAccountId: string | null;
  onDone: () => void;
  onConnected: (library: Library, notice: LibraryNotice) => void;
}) {
  const [accountId, setAccountId] = useState(defaultAccountId ?? "");
  const [bucket, setBucket] = useState("");
  const [defaultNewUsers, setDefaultNewUsers] = useState(false);
  const { fieldErrors, clear, report, onChange } = useLibraryFieldErrors();

  const mutation = useLibraryWrite({
    mutationFn: connectLibrary,
    succeeded: ({ library, scan }) => connectedNotice(library, scan),
    fields: () => FIELDS,
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const target = event.currentTarget;
    const form = new FormData(target);
    clear();
    const request: NewLibrary = {
      name: String(form.get("name") ?? ""),
      accountId: accountId.trim(),
      bucket: bucket.trim(),
      accessKeyId: String(form.get("accessKeyId") ?? ""),
      secretAccessKey: String(form.get("secretAccessKey") ?? ""),
      defaultNewUsers,
    };
    mutation.mutate(request, {
      // The toast is the mutation's (useLibraryWrite); this is only the dialog's part.
      onSuccess: ({ library, scan }) => {
        onDone();
        onConnected(library, connectedNotice(library, scan));
      },
      onError: (error) => {
        if (!report(error, FIELDS, form, target)) {
          // Not a field's to show: the dialog closes, so that its backdrop
          // does not blur the toast that says why.
          onDone();
        }
      },
    });
  }

  return (
    <form onSubmit={onSubmit} onChange={onChange} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>Connect a bucket</DialogTitle>
        <DialogDescription>
          Serve another R2 bucket as a library. The key is tested before anything is saved, and the
          bucket's first scan starts at once.
        </DialogDescription>
      </DialogHeader>
      <FieldGroup>
        <NameField error={fieldErrors.name} />
        <BucketFields
          errors={fieldErrors}
          accountId={accountId}
          bucket={bucket}
          onAccountIdChange={setAccountId}
          onBucketChange={setBucket}
        />
        <KeyFields errors={fieldErrors} />
        <DefaultNewUsersField checked={defaultNewUsers} onCheckedChange={setDefaultNewUsers} />
      </FieldGroup>
      <DialogFooter>
        <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
        <Button type="submit" disabled={mutation.isPending}>
          {mutation.isPending ? "Connecting…" : "Connect bucket"}
        </Button>
      </DialogFooter>
    </form>
  );
}
