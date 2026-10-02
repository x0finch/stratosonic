import { cn } from "cn";
import { type ComponentPropsWithoutRef, type ReactNode, useId } from "react";

/**
 * One block of a page inside the shell (#125): a small heading, a one-line
 * muted description and the content, with an optional action at the
 * heading's end, as the shadcn/ui Tasks and Settings examples lay them out.
 * The inset is the page's card already, so a block is no card of its own.
 *
 * The heading is an h2, under the page's h1 (the header's breadcrumb), and
 * names the section, which so becomes a region. A page of a single block
 * (#128) gives no `title`: the h1 names it already, so the block has no h2
 * and is no named region, and shows only its description, its action and
 * its content. The content's text is `text-sm`, the console's body size, as
 * a card's was.
 */
export function Section({
  title,
  description,
  action,
  className,
  children,
  "aria-label": ariaLabel,
  ...props
}: Omit<ComponentPropsWithoutRef<"section">, "title"> & {
  title?: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}) {
  const id = useId();
  // An empty title is no title: a heading with no words names nothing.
  const titled = title !== undefined && title !== null && title !== false && title !== "";
  const Root = titled ? "section" : "div";
  const header =
    titled || description || action ? (
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-col gap-1">
          {titled ? (
            <h2 id={id} className="font-heading text-base font-medium">
              {title}
            </h2>
          ) : null}
          {description ? (
            <p className="max-w-prose text-sm text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
      </div>
    ) : null;

  return (
    // A plain div is no region, so it takes no region's name either.
    <Root
      aria-labelledby={titled ? id : undefined}
      aria-label={titled ? ariaLabel : undefined}
      className={cn("flex min-w-0 flex-col gap-4 text-sm", className)}
      {...props}
    >
      {header}
      {children}
    </Root>
  );
}
