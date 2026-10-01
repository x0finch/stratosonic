import { type FormEvent, type ReactNode, useCallback, useState } from "react";

import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import {
  type FieldErrors,
  fieldErrorsFrom,
  NO_FIELD_ERRORS,
  stillCurrent,
  withoutFieldError,
} from "@/lib/field-errors";
import { ADMIN_HELP, USER_FIELDS_BY_CODE } from "@/lib/subsonic-users";

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

  return { fieldErrors, clear, report, onChange };
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
