import { ApiError } from "@/lib/api";
import { describeError } from "@/lib/errors";

/**
 * The errors a form's last request came back with that belong to one of its
 * fields, by the field's `name` (#103): the words shown beside it.
 *
 * Each belongs to the value it was reported for, so a form drops a field's
 * error as soon as that field's value changes (`withoutFieldError`), drops
 * them all when a new submit starts, before its own checks run
 * (`NO_FIELD_ERRORS`), and keeps only those whose field still holds the value
 * that was sent when the answer comes back (`stillCurrent`).
 */
export type FieldErrors = Readonly<Partial<Record<string, string>>>;

/** No field errors: a form's state before a request and at each submit. */
export const NO_FIELD_ERRORS: FieldErrors = Object.freeze({});

/**
 * The field errors a refused call reports, given the field each error code
 * belongs to; `undefined` for a failure no field owns, which is a toast.
 */
export function fieldErrorsFrom(
  error: unknown,
  fieldsByCode: Readonly<Record<string, string>>,
): FieldErrors | undefined {
  const field =
    error instanceof ApiError && Object.hasOwn(fieldsByCode, error.code)
      ? fieldsByCode[error.code]
      : undefined;
  return field === undefined ? undefined : { [field]: `${describeError(error).title}.` };
}

/**
 * `errors` without `field`'s, whose value has changed. The same object when
 * the field has none, so that typing re-renders nothing.
 */
export function withoutFieldError(errors: FieldErrors, field: string): FieldErrors {
  if (!Object.hasOwn(errors, field)) {
    return errors;
  }
  const { [field]: _dropped, ...rest } = errors;
  return rest;
}

/**
 * `errors` for the fields whose value in `now` is still the one `sent`
 * carried: an answer that arrives after a field was edited no longer speaks
 * for that field.
 */
export function stillCurrent(errors: FieldErrors, sent: FormData, now: FormData): FieldErrors {
  return Object.fromEntries(
    Object.entries(errors).filter(([field]) => sent.get(field) === now.get(field)),
  );
}
