import { toast } from "@/components/ui/toast";
import { describeError } from "@/lib/errors";

/**
 * What a form did, or why it failed, as the official toast (#101). The
 * toaster is mounted at the root (main.tsx), so a toast raised just before a
 * navigation still shows on the page the navigation opens. Field-level
 * validation stays inline, beside its field, and a state that replaces a
 * whole page stays on that page.
 */
export function toastSuccess(title: string, description: string): void {
  toast.add({ type: "success", title, description });
}

/**
 * A failed call, in words, announced urgently. `title` names what failed in
 * place of the error's own title. A toast with the `id` of one still shown
 * replaces it rather than stacking beside it.
 */
export function toastError(error: unknown, options: { title?: string; id?: string } = {}): void {
  const message = describeError(error);
  toast.add({
    type: "error",
    priority: "high",
    title: options.title ?? message.title,
    description: message.description,
    ...(options.id !== undefined && { id: options.id }),
  });
}
