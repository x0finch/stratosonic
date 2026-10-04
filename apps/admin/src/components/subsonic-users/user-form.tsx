import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";

import { Checkbox } from "@/components/ui/checkbox";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import type { LibraryName } from "@/lib/api";
import {
  type FieldErrors,
  fieldErrorsFrom,
  NO_FIELD_ERRORS,
  stillCurrent,
  withoutFieldError,
} from "@/lib/field-errors";
import {
  ADMIN_HELP,
  ADMIN_LIBRARIES,
  USER_FIELDS_BY_CODE,
  type UserWriteNotices,
  userWriteOptions,
} from "@/lib/subsonic-users";
import { toastError, toastSuccess } from "@/lib/toasts";

/** The page's toasts, as a user write raises them. */
const TOASTS: UserWriteNotices = {
  success: toastSuccess,
  error: (error) => toastError(error),
};

/**
 * A user write: its toast and the list's re-read run on the mutation itself,
 * so they hold even when the dialog closes before the answer comes back
 * (`userWriteOptions`). With `fields`, a refusal that belongs to a field is
 * left to the dialog to show beside it, while the dialog is still there.
 */
export function useUserWrite<TData, TVariables>(write: {
  mutationFn: (variables: TVariables) => Promise<TData>;
  succeeded: (data: TData, variables: TVariables) => { title: string; description: string };
  fields?: boolean;
}) {
  const queryClient = useQueryClient();
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  return useMutation(
    userWriteOptions(queryClient, TOASTS, {
      mutationFn: write.mutationFn,
      succeeded: write.succeeded,
      fieldShown: write.fields
        ? (error) => mounted.current && fieldErrorsFrom(error, USER_FIELDS_BY_CODE) !== undefined
        : undefined,
    }),
  );
}

/**
 * The field errors of one of the page's dialogs, kept as the console's other
 * forms keep theirs (#103): a submit clears them, a refusal that belongs to a
 * field is shown beside it while that field still holds the value it was
 * reported for, and editing the field drops it.
 */
export function useUserFieldErrors() {
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>(NO_FIELD_ERRORS);

  const clear = useCallback(() => setFieldErrors(NO_FIELD_ERRORS), []);

  /** Whether `error` was a field's; if so, it now shows beside that field. */
  const report = useCallback((error: unknown, sent: FormData, form: HTMLFormElement): boolean => {
    const reported = fieldErrorsFrom(error, USER_FIELDS_BY_CODE);
    if (reported) {
      setFieldErrors(stillCurrent(reported, sent, new FormData(form)));
    }
    return reported !== undefined;
  }, []);

  const onChange = useCallback((event: FormEvent<HTMLFormElement>) => {
    if (event.target instanceof HTMLInputElement) {
      const { name } = event.target;
      setFieldErrors((errors) => withoutFieldError(errors, name));
    }
  }, []);

  /** Drops a field's error: for a control that is no text input, such as the Libraries boxes. */
  const drop = useCallback((name: string) => {
    setFieldErrors((errors) => withoutFieldError(errors, name));
  }, []);

  return { fieldErrors, clear, report, onChange, drop };
}

/** A field's error beside it, as the account form shows its own. */
export function UserFieldError({ message }: { message: string | undefined }) {
  return message ? <FieldError>{message}</FieldError> : null;
}

/**
 * The **Subsonic admin** switch with its helper text (#82). `locked` says
 * why it cannot be turned off, when it cannot.
 */
export function AdminSwitchField({
  checked,
  onCheckedChange,
  locked,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  locked?: ReactNode;
}) {
  return (
    <Field orientation="horizontal" data-disabled={locked ? true : undefined}>
      <FieldContent>
        <FieldLabel htmlFor="is-admin">Subsonic admin</FieldLabel>
        <FieldDescription>{ADMIN_HELP}</FieldDescription>
        {locked && <FieldDescription>{locked}</FieldDescription>}
      </FieldContent>
      <Switch
        id="is-admin"
        checked={checked}
        onCheckedChange={(next) => onCheckedChange(next)}
        disabled={Boolean(locked)}
      />
    </Field>
  );
}

/**
 * The **Libraries** field (#84, "Per-user access"): one checkbox per library
 * a user may be given, for a user who is not a Subsonic admin. A Subsonic
 * admin sees every library, so for one the boxes give way to a muted line.
 * With no box checked, "Choose at least one library." shows beneath, as
 * does a refusal the server reported for the field. Only shown where more
 * than one library exists (lib/subsonic-users.ts, `showsLibraries`).
 */
export function LibrariesField({
  libraries,
  isAdmin,
  checked,
  onCheckedChange,
  error,
}: {
  libraries: readonly LibraryName[];
  isAdmin: boolean;
  checked: readonly number[];
  onCheckedChange: (libraryIds: number[]) => void;
  error: string | undefined;
}) {
  if (isAdmin) {
    return (
      <FieldSet>
        <FieldLegend variant="label">Libraries</FieldLegend>
        <FieldDescription>{ADMIN_LIBRARIES}</FieldDescription>
      </FieldSet>
    );
  }
  const set = new Set(checked);
  return (
    <FieldSet data-invalid={error ? true : undefined}>
      <FieldLegend variant="label">Libraries</FieldLegend>
      <FieldGroup data-slot="checkbox-group">
        {libraries.map((library) => {
          const id = `user-library-${library.id}`;
          return (
            <Field key={library.id} orientation="horizontal">
              <Checkbox
                id={id}
                checked={set.has(library.id)}
                aria-invalid={error ? true : undefined}
                onCheckedChange={(next) =>
                  onCheckedChange(
                    libraries
                      .map(({ id: libraryId }) => libraryId)
                      .filter((libraryId) =>
                        libraryId === library.id ? next : set.has(libraryId),
                      ),
                  )
                }
              />
              <FieldLabel htmlFor={id} className="min-w-0 font-normal wrap-anywhere">
                {library.name}
              </FieldLabel>
            </Field>
          );
        })}
      </FieldGroup>
      <UserFieldError message={error} />
    </FieldSet>
  );
}
