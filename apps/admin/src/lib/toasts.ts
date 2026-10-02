import { toast } from "@/components/ui/toast";
import { describeError } from "@/lib/errors";

/**
 * What a form did, or why it failed, as the official toast (#101). The
 * toaster is mounted at the root (main.tsx), so a toast raised just before a
 * navigation still shows on the page the navigation opens. Field-level
 * validation stays inline, beside its field, and a state of the whole page
 * stays on that page (components/error-alert.tsx).
 */
export function toastSuccess(title: string, description: string): void {
  toast.add({ type: "success", title, description });
}

/**
 * Something that did not happen, in the console's own words, announced
 * urgently, such as "2 files were not uploaded".
 */
export function toastFailure(title: string, description: string): void {
  toast.add({ type: "error", priority: "high", title, description });
}

/**
 * A failed call, in words, announced urgently. `title` names what failed in
 * place of the error's own title.
 */
export function toastError(error: unknown, title?: string): void {
  const message = describeError(error);
  toast.add({
    type: "error",
    priority: "high",
    title: title ?? message.title,
    description: message.description,
  });
}
