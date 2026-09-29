import { CircleAlertIcon } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { describeError } from "@/lib/errors";

/**
 * A failed call, in words, as the official destructive alert. `title` names
 * what failed in place of the error's own title.
 */
export function ErrorAlert({ error, title }: { error: unknown; title?: string }) {
  const message = describeError(error);

  return (
    <Alert variant="destructive">
      <CircleAlertIcon />
      <AlertTitle>{title ?? message.title}</AlertTitle>
      <AlertDescription>{message.description}</AlertDescription>
    </Alert>
  );
}
