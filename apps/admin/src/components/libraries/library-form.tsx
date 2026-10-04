import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";

import { PasswordInput } from "@/components/subsonic-users/password-input";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  type FieldErrors,
  NO_FIELD_ERRORS,
  stillCurrent,
  withoutFieldError,
} from "@/lib/field-errors";
import {
  type LibraryField,
  type LibraryNotice,
  type LibraryWriteNotices,
  libraryFieldErrors,
  libraryWriteOptions,
} from "@/lib/libraries";
import { toastError, toastFailure, toastSuccess } from "@/lib/toasts";

/** The page's toasts, as a library write raises them. */
const TOASTS: LibraryWriteNotices = {
  success: toastSuccess,
  failure: toastFailure,
  error: (error) => toastError(error),
};

/** The longest library name the server takes, trimmed (#84). */
export const MAX_LIBRARY_NAME_LENGTH = 64;
/** The longest key the server takes; R2's are 32 and 64 characters. */
const MAX_KEY_LENGTH = 256;

/**
 * A library write: its toast and the list's re-read run on the mutation
 * itself, so they hold even when the dialog closes before the answer comes
 * back (`libraryWriteOptions`). With `fields`, a refusal that belongs to
 * one of those fields is left to the dialog to show beside it, while the
 * dialog is still there.
 */
export function useLibraryWrite<TData, TVariables>(write: {
  mutationFn: (variables: TVariables) => Promise<TData>;
  succeeded: (data: TData, variables: TVariables) => LibraryNotice;
  fields?: () => readonly LibraryField[];
}) {
  const queryClient = useQueryClient();
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const { fields } = write;
  return useMutation(
    libraryWriteOptions(queryClient, TOASTS, {
      mutationFn: write.mutationFn,
      succeeded: write.succeeded,
      fieldShown: fields
        ? (error) => mounted.current && libraryFieldErrors(error, fields()) !== undefined
        : undefined,
    }),
  );
}

/**
 * The field errors of the connect and edit dialogs, kept as the console's
 * other forms keep theirs (#103): a submit clears them, a refusal that
 * belongs to a shown field is shown beside it while that field still holds
 * the value it was reported for, and editing the field drops it. A refused
 * key belongs to the pair, so editing either key drops it.
 */
export function useLibraryFieldErrors() {
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>(NO_FIELD_ERRORS);

  const clear = useCallback(() => setFieldErrors(NO_FIELD_ERRORS), []);

  /** Whether `error` was a shown field's; if so, it now shows beside that field. */
  const report = useCallback(
    (
      error: unknown,
      shown: readonly LibraryField[],
      sent: FormData,
      form: HTMLFormElement,
    ): boolean => {
      const reported = libraryFieldErrors(error, shown);
      if (reported) {
        const now = new FormData(form);
        const current = stillCurrent(reported, sent, now);
        // The pair's error also goes when the other key was edited meanwhile.
        const keyEdited = sent.get("accessKeyId") !== now.get("accessKeyId");
        setFieldErrors(keyEdited ? withoutFieldError(current, "secretAccessKey") : current);
      }
      return reported !== undefined;
    },
    [],
  );

  const onChange = useCallback((event: FormEvent<HTMLFormElement>) => {
    if (event.target instanceof HTMLInputElement) {
      const name = event.target.name === "accessKeyId" ? "secretAccessKey" : event.target.name;
      setFieldErrors((errors) => withoutFieldError(errors, name));
    }
  }, []);

  return { fieldErrors, clear, report, onChange };
}

/** A field's error beside it, as the console's other forms show their own. */
export function LibraryFieldError({ message }: { message: string | undefined }) {
  return message ? <FieldError>{message}</FieldError> : null;
}

/** The library's name, which Subsonic clients show in their folder picker. */
export function NameField({
  error,
  defaultValue,
}: {
  error: string | undefined;
  defaultValue?: string;
}) {
  return (
    <Field data-invalid={error ? true : undefined}>
      <FieldLabel htmlFor="library-name">Name</FieldLabel>
      <Input
        id="library-name"
        name="name"
        autoComplete="off"
        maxLength={MAX_LIBRARY_NAME_LENGTH}
        defaultValue={defaultValue}
        aria-invalid={error ? true : undefined}
        required
      />
      <LibraryFieldError message={error} />
      <FieldDescription>Subsonic clients show it in their folder picker.</FieldDescription>
    </Field>
  );
}

/** The Cloudflare account that owns the bucket, and the bucket. */
export function BucketFields({
  errors,
  accountId,
  bucket,
  onAccountIdChange,
  onBucketChange,
}: {
  errors: FieldErrors;
  accountId: string;
  bucket: string;
  onAccountIdChange: (value: string) => void;
  onBucketChange: (value: string) => void;
}) {
  return (
    <>
      <Field data-invalid={errors.accountId ? true : undefined}>
        <FieldLabel htmlFor="library-account-id">Account ID</FieldLabel>
        <Input
          id="library-account-id"
          name="accountId"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={32}
          value={accountId}
          onChange={(event) => onAccountIdChange(event.target.value)}
          aria-invalid={errors.accountId ? true : undefined}
          required
        />
        <LibraryFieldError message={errors.accountId} />
      </Field>
      <Field data-invalid={errors.bucket ? true : undefined}>
        <FieldLabel htmlFor="library-bucket">Bucket</FieldLabel>
        <Input
          id="library-bucket"
          name="bucket"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={63}
          value={bucket}
          onChange={(event) => onBucketChange(event.target.value)}
          aria-invalid={errors.bucket ? true : undefined}
          required
        />
        <LibraryFieldError message={errors.bucket} />
      </Field>
    </>
  );
}

/** An R2 API token's two keys, with the helper text that says which token to make. */
export function KeyFields({ errors }: { errors: FieldErrors }) {
  const refused = errors.secretAccessKey ? true : undefined;
  return (
    <>
      <Field data-invalid={refused}>
        <FieldLabel htmlFor="library-access-key-id">Access Key ID</FieldLabel>
        <Input
          id="library-access-key-id"
          name="accessKeyId"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={MAX_KEY_LENGTH}
          aria-invalid={refused}
          required
        />
        <FieldDescription>
          Create an R2 API token with Object Read &amp; Write on this bucket only, and paste its
          keys here.
        </FieldDescription>
      </Field>
      <Field data-invalid={refused}>
        <FieldLabel htmlFor="library-secret-access-key">Secret Access Key</FieldLabel>
        <PasswordInput
          id="library-secret-access-key"
          name="secretAccessKey"
          autoComplete="off"
          maxLength={MAX_KEY_LENGTH}
          aria-invalid={refused}
          required
        />
        <LibraryFieldError message={errors.secretAccessKey} />
      </Field>
    </>
  );
}

/** Whether new Subsonic users get the library, as Navidrome's `default_new_users`. */
export function DefaultNewUsersField({
  checked,
  onCheckedChange,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <Field orientation="horizontal">
      <Checkbox
        id="library-default-new-users"
        checked={checked}
        onCheckedChange={(next) => onCheckedChange(next)}
      />
      <FieldLabel htmlFor="library-default-new-users">Give new Subsonic users access</FieldLabel>
    </Field>
  );
}
