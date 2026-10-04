import { TriangleAlertIcon } from "lucide-react";
import { type FormEvent, useState } from "react";

import {
  BucketFields,
  DefaultNewUsersField,
  KeyFields,
  NameField,
  useLibraryFieldErrors,
  useLibraryWrite,
} from "@/components/libraries/library-form";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { type Library, type LibraryChanges, updateLibrary } from "@/lib/api";
import {
  BUCKET_CHANGE_NOTE,
  bucketMoves,
  type LibraryField,
  libraryChanges,
  savedNotice,
} from "@/lib/libraries";

/**
 * Edits a library (#84): its name and whether new Subsonic users get it,
 * and for a connected library also its account, its bucket and, with
 * **Replace credentials**, a new token. Library 1, the bound bucket, takes
 * its name and its default only. A change of account, bucket or key is
 * tested before it is saved, as a connect is.
 */
export function EditDialog({
  library,
  open,
  onOpenChange,
}: {
  library: Library | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* A form taller than a phone's screen scrolls inside the dialog. */}
      <DialogContent className="max-h-svh overflow-y-auto">
        {library && (
          <EditForm key={library.id} library={library} onDone={() => onOpenChange(false)} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function EditForm({ library, onDone }: { library: Library; onDone: () => void }) {
  const connected = library.kind !== "r2-binding";
  const [defaultNewUsers, setDefaultNewUsers] = useState(library.defaultNewUsers);
  const [accountId, setAccountId] = useState(library.accountId ?? "");
  const [bucket, setBucket] = useState(library.bucket ?? "");
  const [replaceCredentials, setReplaceCredentials] = useState(false);
  const { fieldErrors, clear, report, onChange } = useLibraryFieldErrors();

  // The fields on screen: a refusal for one that is not (the stored key,
  // refused while only the bucket changes) is a toast.
  const shown: readonly LibraryField[] = [
    "name",
    ...(connected ? (["accountId", "bucket"] as const) : []),
    ...(replaceCredentials ? (["accessKeyId", "secretAccessKey"] as const) : []),
  ];

  const mutation = useLibraryWrite({
    mutationFn: (changes: LibraryChanges) => updateLibrary(library.id, changes),
    succeeded: ({ library: saved, scan }, changes) => savedNotice(library, saved, changes, scan),
    fields: () => shown,
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const target = event.currentTarget;
    const form = new FormData(target);
    clear();
    const changes = libraryChanges(library, {
      name: String(form.get("name") ?? ""),
      defaultNewUsers,
      accountId,
      bucket,
      replaceCredentials,
      accessKeyId: String(form.get("accessKeyId") ?? ""),
      secretAccessKey: String(form.get("secretAccessKey") ?? ""),
    });
    if (!changes) {
      onDone();
      return;
    }
    mutation.mutate(changes, {
      // The toast is the mutation's (useLibraryWrite); this is only the dialog's part.
      onSuccess: onDone,
      onError: (error) => {
        if (!report(error, shown, form, target)) {
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
        <DialogTitle>Edit {library.name}</DialogTitle>
        <DialogDescription>
          {connected
            ? "Rename the library, or point it at another bucket or key. A new bucket or key is tested before it is saved."
            : "Rename the library. It is the bucket the Worker is bound to, which stays as it is."}
        </DialogDescription>
      </DialogHeader>
      <FieldGroup>
        <NameField error={fieldErrors.name} defaultValue={library.name} />
        {connected && (
          <>
            <BucketFields
              errors={fieldErrors}
              accountId={accountId}
              bucket={bucket}
              onAccountIdChange={setAccountId}
              onBucketChange={setBucket}
            />
            {bucketMoves(library, { accountId, bucket }) && (
              <Alert>
                <TriangleAlertIcon />
                <AlertDescription>{BUCKET_CHANGE_NOTE}</AlertDescription>
              </Alert>
            )}
            <Field orientation="horizontal">
              <Checkbox
                id="library-replace-credentials"
                checked={replaceCredentials}
                onCheckedChange={(next) => setReplaceCredentials(next)}
              />
              <FieldContent>
                <FieldLabel htmlFor="library-replace-credentials">Replace credentials</FieldLabel>
                <FieldDescription>
                  {library.accessKeyIdHint
                    ? `The stored key ends in ${library.accessKeyIdHint.replace(/^…/, "")}.`
                    : "The stored key cannot be read. Replace it to reach the bucket again."}
                </FieldDescription>
              </FieldContent>
            </Field>
            {replaceCredentials && <KeyFields errors={fieldErrors} />}
          </>
        )}
        <DefaultNewUsersField checked={defaultNewUsers} onCheckedChange={setDefaultNewUsers} />
      </FieldGroup>
      <DialogFooter>
        <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
        <Button type="submit" disabled={mutation.isPending}>
          {mutation.isPending ? "Saving…" : "Save"}
        </Button>
      </DialogFooter>
    </form>
  );
}
