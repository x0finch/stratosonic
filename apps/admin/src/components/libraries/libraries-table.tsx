import {
  CircleAlertIcon,
  EllipsisIcon,
  PencilIcon,
  PlugZapIcon,
  ShieldCheckIcon,
  Trash2Icon,
} from "lucide-react";

import { RelativeTime } from "@/components/relative-time";
import { Badge, badgeVariants } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Library } from "@/lib/api";
import { formatBytes, formatCount, MISSING } from "@/lib/format";
import { type LibraryBadge, libraryBadges, removable } from "@/lib/libraries";

/** What a row's menu can do, for one library. */
export type LibraryAction = "edit" | "test" | "cors" | "remove";

/**
 * The libraries, in id order, so the bound bucket comes first (#84,
 * "Console"): each name with its state badges, the bucket, when the scan
 * last finished it, and what it holds. Text columns come first and the
 * numbers last (DESIGN.md, "Tables"). On a narrow screen the bucket, the
 * albums and the size give way.
 *
 * `onAction` opens what a row's menu offers. Without `writable` (no
 * `libraries:write`) the menu offers only the bucket's CORS rule, which
 * changes nothing; a library being removed has no menu.
 */
export function LibrariesTable({
  libraries,
  now,
  writable,
  onAction,
}: {
  libraries: readonly Library[];
  now: number;
  writable: boolean;
  onAction: (action: LibraryAction, library: Library) => void;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead className="hidden sm:table-cell">Bucket</TableHead>
          <TableHead>Last scan</TableHead>
          <TableHead className="hidden text-right md:table-cell">Albums</TableHead>
          <TableHead className="text-right">Tracks</TableHead>
          <TableHead className="hidden text-right sm:table-cell">Size</TableHead>
          <TableHead className="w-0">
            <span className="sr-only">Actions</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {libraries.map((library) => (
          <TableRow key={library.id}>
            {/* Every cell aligns to the name's first line, as the Files
                table's do: the text cells sit as far down as centres a line
                on the menu button, and the badges wrap beneath the name. */}
            <TableCell className="py-3 align-top">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="max-w-48 truncate font-medium">{library.name}</span>
                {libraryBadges(library).map((badge) => (
                  <StateBadge key={badge.label} badge={badge} />
                ))}
              </div>
            </TableCell>
            <TableCell className="hidden py-3 align-top sm:table-cell">
              {library.bucket === null ? (
                <span className="text-muted-foreground">{MISSING}</span>
              ) : (
                <span className="font-mono">{library.bucket}</span>
              )}
            </TableCell>
            <TableCell className="py-3 align-top text-muted-foreground">
              {library.lastScanAt === null ? (
                "Never"
              ) : (
                <RelativeTime iso={library.lastScanAt} now={now} />
              )}
            </TableCell>
            <TableCell className="hidden py-3 text-right align-top tabular-nums md:table-cell">
              {formatCount(library.counts.albums)}
            </TableCell>
            <TableCell className="py-3 text-right align-top tabular-nums">
              {formatCount(library.counts.tracks)}
            </TableCell>
            <TableCell className="hidden py-3 text-right align-top tabular-nums sm:table-cell">
              {formatBytes(library.counts.sizeBytes)}
            </TableCell>
            <TableCell className="text-right align-top">
              {library.state === "active" && (
                <LibraryMenu library={library} writable={writable} onAction={onAction} />
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/**
 * A state badge. "Scan failed" carries its reason in a tooltip, on a
 * button so the keyboard reaches it, and in its accessible name.
 */
function StateBadge({ badge }: { badge: LibraryBadge }) {
  if (badge.reason === undefined) {
    return <Badge variant="outline">{badge.label}</Badge>;
  }
  return (
    <Tooltip>
      <TooltipTrigger className={badgeVariants({ variant: "outline" })}>
        <CircleAlertIcon data-icon="inline-start" />
        {badge.label}
        <span className="sr-only">: {badge.reason}</span>
      </TooltipTrigger>
      <TooltipContent>{badge.reason}</TooltipContent>
    </Tooltip>
  );
}

function LibraryMenu({
  library,
  writable,
  onAction,
}: {
  library: Library;
  writable: boolean;
  onAction: (action: LibraryAction, library: Library) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${library.name}`} />
        }
      >
        <EllipsisIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {writable && (
          <>
            <DropdownMenuItem onClick={() => onAction("edit", library)}>
              <PencilIcon />
              Edit
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onAction("test", library)}>
              <PlugZapIcon />
              Test connection
            </DropdownMenuItem>
          </>
        )}
        <DropdownMenuItem onClick={() => onAction("cors", library)}>
          <ShieldCheckIcon />
          Bucket CORS
        </DropdownMenuItem>
        {writable && removable(library) && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={() => onAction("remove", library)}>
              <Trash2Icon />
              Remove
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
