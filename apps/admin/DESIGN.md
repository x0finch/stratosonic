# Console design rules

Every page and component in `apps/admin` follows these rules. They adapt the
design judgment of Vercel's design guidelines (<https://vercel.com/design.md>)
to a console built from stock shadcn/ui on Base UI. Vercel's own brand
system (its logos, header and footer shell, and `vbg-*` CSS) is not used.

The target is a calm, precise console: hierarchy comes from typography,
spacing and alignment, and color and surfaces are kept for meaning.

## Foundation

- **Use shadcn/ui as generated.** Components come from the shadcn CLI
  (`pnpm exec shadcn add <component>`) with the Nova preset and the `neutral`
  base color. `src/components/ui/*` and `src/index.css` stay as the CLI wrote
  them. A page composes these components and lays them out with Tailwind
  layout utilities (flex, grid, gap, padding, width, overflow, borders).
- **Use only the theme's named colors,** the color tokens defined in
  `src/index.css`: `background`, `foreground`, `muted`, `muted-foreground`,
  `border`, `input`, `ring`, `primary`, `secondary`, `accent`, `card`,
  `popover`, `destructive` (each with its `-foreground` pair where the theme
  has one), `chart-1` to `chart-5`, and `sidebar-*`. Each is used through its
  Tailwind class, for example `text-muted-foreground`, `border` or `bg-muted`,
  so the light and dark themes stay the theme's own.
- **Prefer a component's own props** (`variant`, `size`) to restyling it. When
  no variant fits, compose a different official component.
- **Use Tailwind's scales only.** Sizes, weights, spacing and radii come from
  Tailwind's named steps (`text-sm`, `font-medium`, `gap-4`, `rounded-lg`).
- **Code taken from a shadcn block or guide keeps its classes** (the
  sidebar-08 shell, the `login-01` forms, `mode-toggle.tsx`), so it stays
  comparable with its source.

## Color

- **Design in monochrome.** Color is added only when it carries meaning: a
  state, an action, or a data series.
- **Pair every color with a second cue,** such as a word, an icon or a
  position, so the meaning survives without color.
- **`destructive` is for destructive actions and errors only,** such as
  Delete or a failed request. A favorable or important value keeps the
  regular `foreground`.
- **Charts use `chart-1` to `chart-5`,** through the shadcn chart
  component's `ChartConfig`.

## Surfaces and boundaries

The sidebar-08 inset is the page's surface. Content inside it sits directly on
it.

- **Group with spacing first,** then alignment and type, and only then a
  line. A `Separator` or a hairline `border` marks a real boundary between
  groups that spacing alone cannot show.
- **Inside the shell, a block is a `Section`** (`src/components/section.tsx`):
  an h2, a short muted description, an optional action at the heading's
  end, and the content. Follow the shadcn Tasks and Settings examples.
- **A page with a single block has no section heading,** as Subsonic users
  and Account. The header's h1 names the page, so the `Section` gets no
  `title`: it renders no h2, is no named region, and shows its
  description, any action and its content.
- **A section's action is `size="sm"`.** The page's main action keeps the
  default variant ("Add user"); a secondary action is `outline` ("Scan
  now").
- **`Card` belongs to full-screen pages outside the shell:** sign-in, setup
  and the error screen, as in the `login-01` block.
- **Overlays carry their own surface:** dialogs, alert dialogs, menus,
  popovers, toasts and tooltips are the components' own and need no extra
  container.
- **Keep the theme's radius** (`--radius` and its `rounded-*` steps) and the
  components' own shadows. Every surface stays flat: no gradients, glows,
  blurs, textures or decorative shadows.

## Typography

- **Geist** (`font-sans`, `font-heading`) is for all text, including
  numbers, dates and table cells. `font-mono` (Tailwind's default monospace
  stack) is for short identifiers only: a path, an R2 key, an id, a command.
  Only the identifier itself is set in mono, not its sentence or column.
- **Fixed roles:**

  | Role | Element | Classes |
  |---|---|---|
  | Page title | h1, the header's breadcrumb page | as the sidebar-08 block sets it |
  | Section heading | h2 in `Section` | `font-heading text-base font-medium` |
  | Sub-heading | h3 inside a section | `text-sm font-medium` |
  | Body and table text | p, td | `text-sm` |
  | Description and labels | p, dt, helper text | `text-sm text-muted-foreground` |
  | Metadata | a meter's label and value, or a secondary line under an item | `text-xs`, muted except the value |
  | Key figure | dd of a stat | `text-2xl font-semibold tabular-nums` |

- **Peers share one role.** Equivalent items use the same size, weight and
  numeric treatment, whatever the length of their value.
- **One h1 per page, then h2 per section, then h3.** The order follows the
  page's structure.
- **Headings are sentence case and name what the block shows,** in the
  product's own vocabulary ("Library scan", "Subsonic users").
- **Copy is plain and specific.** Use sentence case and concrete nouns and
  verbs. A description that is a full sentence ends with a period; a short
  phrase ("Tracks by genre") does not. In sentences, use commas, colons or
  parentheses in place of em dashes, and write labels in sentence case
  rather than all caps.
- **Recent events are relative times** ("2 minutes ago", "yesterday", or
  "Never" for none), as `src/components/relative-time.tsx` writes them: a
  `<time dateTime>` with the absolute time in its `title`.
- **Readable prose:** keep body text at `text-sm` (the metadata role is for
  short secondary lines, never for paragraphs), and keep
  explanatory paragraphs to a comfortable measure (about `max-w-prose`).

## Spacing and layout

- **Spacing expresses relationships:**
  - inside a group (label to value, heading to description): `gap-1` to
    `gap-3`;
  - between items of a group, or a heading to its content: `gap-4`;
  - between sections: `gap-6` to `gap-10`, with a `Separator` where the
    page changes subject.
- **Each gap has one owner.** The parent sets it with `gap-*` on a flex or
  grid. Children carry no outer spacing margins; auto margins that center a
  column or push an item to the end (`mx-auto`, `m-auto`, `ml-auto`) are
  layout, not spacing. The other exception is a divided
  grid that clips its outer borders, as in `LibraryTotals`: the grid is
  shifted by one border and one gutter (`-mt-px -ml-4`) inside an
  `overflow-hidden` box, so dividers fall only between items.
- **The shell's column** (`mx-auto max-w-7xl` in `src/routes/_shell.tsx`)
  holds every page, from its top. A focused form, such as Account, uses a
  narrow column, centered across and aligned to the top like every other
  page (`mx-auto w-full max-w-md`).
- **Align to shared edges.** Peer columns line up, and the first column of a
  row lines up with the sections around it. A table keeps the `Table`
  component's own cell padding, so its first column sits that padding inside
  the section's edge.
- **Balance the grid.** Peers in a row share the row's width, and a split
  with one empty half collapses to one column. On desktop, sections pair in
  two columns where both are real peers. On mobile everything stacks.
- **Flex and grid children that hold text get `min-w-0`,** so they wrap
  rather than overflow.

## Tables

- Use the shadcn `Table` (a semantic `<table>`), spanning the section's full
  width, with its introduction above it.
- Text columns and their headers align left. Numeric columns and their
  headers align right (`text-right`) and use `tabular-nums`.
- Text columns come first and numeric columns sit at the right end, so a
  right-aligned number never runs into a left-aligned text column
  ("Album, Added, Year, Tracks").
- Body cells align to the first text line. Keep peer units and precision
  consistent.
- A missing value is one em dash (`—`), the only place an em dash appears.
- Short labels, such as usernames and dates, stay on one line. On narrow
  screens, drop secondary columns before shrinking the table.

## Charts and figures

- Use a chart only when the relationship reads faster than a table.
- Length encodings start at zero, and all bars of a set share one scale and
  one label lane.
- Label values directly on the marks. A legend is for several series only.
- Every chart sets Recharts' `accessibilityLayer` and labels its values, so
  its data is readable without the picture.
- Charts render without animation: every series sets
  `isAnimationActive={false}`.
- A page's key figures are one row (`dl`) with thin dividers, as in
  `LibraryTotals`, rather than a grid of boxes. Small label and value pairs
  inside a section are a plain `dl` grid.

## Badges and icons

- A `Badge` marks a real state or role, such as "Subsonic admin" or
  "Playing". Ordinary metadata stays plain text.
- Icons come from `lucide-react`, the shadcn icon library. Use an icon where
  it makes an action quicker to recognize (sidebar items, the row menu, show
  and hide), at the component's own size, next to a text label or an
  `aria-label`.

## Feedback

- The outcome of an action is a **toast** (`src/lib/toasts.ts`).
- A field's validation error stays **inline beside its field**
  (`src/lib/field-errors.ts`).
- A state that is the whole page is an **inline `Alert`** on the page
  (`src/components/error-alert.tsx`).
- Loading states use `Skeleton` or the official `Spinner`, sized like the
  content they replace.
- An empty table, list or page uses the official `Empty`. An empty small
  section, such as Now playing with nobody listening, is one left-aligned
  muted line (`text-sm text-muted-foreground`).

The details are in README.md, "Signing in".

## Motion

- Stillness is the default. Motion comes only from the components' own
  transitions (dialog, menu, toast, sidebar, `Skeleton`, `Spinner`), which
  stay as generated, and from progress that reports a real state, such as a
  running scan.
- Our own markup adds no animation. Where it must, the animation is wrapped
  in `motion-safe:` so `prefers-reduced-motion` turns it off.

## Navigation

- The sidebar lists only pages that exist. A page's entry is added with the
  page, in the phase that ships it, never as a disabled placeholder.

## Themes

- **Light and dark are equal.** Every page keeps the same hierarchy and
  contrast in both.
- **The theme toggle stays.** `mode-toggle.tsx` is shadcn's Vite dark-mode
  toggle and follows the system by default. This departs from Vercel's
  guidance against a visible switcher, which is written for report pages;
  a console is a working tool used for long sessions.

## Accessibility

- Use landmarks, one h1, ordered headings, and a `section` named by its h2
  (`aria-labelledby`). A block with no visible heading, such as the key
  figures row, is a `section` named by `aria-label`.
- Every control has a visible label or an `aria-label`. Focus stays visible
  through the components' own `ring`.
- Contrast meets WCAG AA in both themes. Color is never the only cue.

## Responsive

- At 390 px wide, nothing scrolls horizontally. The page scrolls only inside
  the inset, and the header and sidebar stay put.
- Reflow before shrinking. Columns stack, secondary table columns hide, and
  actions wrap under their heading.

## Checking a UI change

Before a UI change is done:

1. Render the page in the real app (see README.md, "Local development"),
   with data on the page.
2. Screenshot it at 1440 px in light and dark and at 390 px, and look at each
   one:
   - hierarchy reads at a glance;
   - peers line up;
   - no stray box or border;
   - no empty half-row;
   - no overflow;
   - toasts are readable.
3. Walk this file's sections against the change. Every rule above holds.
