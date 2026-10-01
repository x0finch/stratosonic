import { cn } from "cn";
import { type ComponentProps, type ReactNode, useId } from "react";

/**
 * One block of a page inside the shell (#125): a small heading, a one-line
 * muted description and the content, with an optional action at the
 * heading's end, as the shadcn/ui Tasks and Settings examples lay them out.
 * The inset is the page's card already, so a block is no card of its own.
 *
 * The heading is an h2, under the page's h1 (the header's breadcrumb), and
 * names the section, which so becomes a region.
 */
export function Section({
  title,
  description,
  action,
  className,
  children,
  ...props
}: Omit<ComponentProps<"section">, "title"> & {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}) {
  const id = useId();

  return (
    <section
      aria-labelledby={id}
      className={cn("flex min-w-0 flex-col gap-4", className)}
      {...props}
    >
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 id={id} className="font-heading text-base leading-snug font-medium">
            {title}
          </h2>
          {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
        </div>
        {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
      </div>
      {children}
    </section>
  );
}
