import { CircleAlertIcon } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { describeError } from "@/lib/errors";

/**
 * A failure that is the state of the whole page, in words, as the official
 * destructive alert. It stays on the page for as long as the state lasts; an
 * action's outcome is a toast instead (lib/toasts.ts).
 */
export function ErrorAlert({ error }: { error: unknown }) {
  const message = describeError(error);

  return (
    <Alert variant="destructive">
      <CircleAlertIcon />
      <AlertTitle>{message.title}</AlertTitle>
      <AlertDescription>{message.description}</AlertDescription>
    </Alert>
  );
}
