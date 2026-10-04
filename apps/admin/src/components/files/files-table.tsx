import {
  EllipsisIcon,
  FileAudioIcon,
  FileIcon,
  FileTextIcon,
  FolderIcon,
  ImageIcon,
  ListMusicIcon,
  Trash2Icon,
} from "lucide-react";
import type { ReactNode } from "react";

import { FolderLink } from "@/components/files/folder-path";
import { RelativeTime } from "@/components/relative-time";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
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
import type { FileEntry, FileKind, FolderEntry } from "@/lib/api";
import { type DeleteTarget, targetId } from "@/lib/files";
import { formatBytes, MISSING } from "@/lib/format";

/** A row's icon, at the size of the text beside it. */
const ICON = "size-4 shrink-0 text-muted-foreground";

/** Each kind's icon, beside the file's name. */
const KIND_ICONS: Record<FileKind, ReactNode> = {
  audio: <FileAudioIcon className={ICON} />,
  lyrics: <FileTextIcon className={ICON} />,
  playlist: <ListMusicIcon className={ICON} />,
  image: <ImageIcon className={ICON} />,
  other: <FileIcon className={ICON} />,
};

/** What the table's rows can do, for a role that may change the bucket here. */
export interface RowActions {
  /** The selected rows, by `targetId`. */
  selected: { has(id: string): boolean };
  onSelect: (targets: readonly DeleteTarget[], selected: boolean) => void;
  onDelete: (target: DeleteTarget) => void;
}

/**
 * One folder's loaded pages: its folders, then its files, in R2's order
 * (#83, "Layout", item 4). A folder's name is a link into it. Name and the
 * time each file was uploaded are text, the size is the number at the end;
 * a folder has neither (`—`). In a narrow column the time gives way.
 *
 * `actions` is absent where nothing may be changed (no `files:write`, or
 * file writes off), and so are the checkboxes and each row's menu.
 */
export function FilesTable({
  library,
  folders,
  files,
  now,
  actions,
}: {
  /** The library browsed, which every folder's link keeps. */
  library: number;
  folders: readonly FolderEntry[];
  files: readonly FileEntry[];
  now: number;
  actions?: RowActions;
}) {
  const rows: DeleteTarget[] = [
    ...folders.map((folder): DeleteTarget => ({ type: "folder", ...folder })),
    ...files.map((file): DeleteTarget => ({ type: "file", key: file.key, name: file.name })),
  ];
  const selectedCount = actions
    ? rows.filter((row) => actions.selected.has(targetId(row))).length
    : 0;
  const allSelected = rows.length > 0 && selectedCount === rows.length;

  return (
    <div className="@container">
      <Table>
        <TableHeader>
          <TableRow>
            {actions ? (
              <TableHead className="w-0">
                <Checkbox
                  aria-label="Select every row shown"
                  checked={allSelected}
                  indeterminate={selectedCount > 0 && !allSelected}
                  onCheckedChange={(checked) => actions.onSelect(rows, checked)}
                />
              </TableHead>
            ) : null}
            <TableHead>Name</TableHead>
            <TableHead className="hidden @md:table-cell">Modified</TableHead>
            <TableHead className="text-right">Size</TableHead>
            {actions ? (
              <TableHead className="w-0">
                <span className="sr-only">Actions</span>
              </TableHead>
            ) : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {folders.map((folder) => (
            <Row
              key={folder.prefix}
              target={{ type: "folder", ...folder }}
              actions={actions}
              icon={<FolderIcon className={ICON} />}
              name={
                <FolderLink
                  library={library}
                  prefix={folder.prefix}
                  className="underline-offset-4 hover:underline"
                >
                  {folder.name}
                </FolderLink>
              }
              modified={MISSING}
              size={MISSING}
            />
          ))}
          {files.map((file) => (
            <Row
              key={file.key}
              target={{ type: "file", key: file.key, name: file.name }}
              actions={actions}
              icon={KIND_ICONS[file.kind]}
              name={file.name}
              modified={<RelativeTime iso={file.uploadedAt} now={now} />}
              size={formatBytes(file.size)}
            />
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function Row({
  target,
  actions,
  icon,
  name,
  modified,
  size,
}: {
  target: DeleteTarget;
  actions: RowActions | undefined;
  icon: ReactNode;
  name: ReactNode;
  modified: ReactNode;
  size: string;
}) {
  const selected = actions?.selected.has(targetId(target)) ?? false;

  return (
    <TableRow data-state={selected ? "selected" : undefined}>
      {actions ? (
        <TableCell className="align-top">
          <div className="flex h-7 items-center">
            <Checkbox
              aria-label={`Select ${target.name}`}
              checked={selected}
              onCheckedChange={(checked) => actions.onSelect([target], checked)}
            />
          </div>
        </TableCell>
      ) : null}
      {/* Every cell aligns to the name's first line, should it wrap: the
          text cells sit as far down as centres a line on the row's controls
          (the menu button, 28 px). `wrap-anywhere` lowers the name cell's
          min-content width, so a long name breaks rather than widening the
          table (as the playlists table's). */}
      <TableCell className="py-3 align-top whitespace-normal wrap-anywhere">
        {/* The icon sits in a box one text line tall, so that it stays
            beside the first line of a name that wraps. */}
        <div className="flex items-start gap-2">
          <span className="flex h-5 shrink-0 items-center">{icon}</span>
          <span className="min-w-0">{name}</span>
        </div>
      </TableCell>
      <TableCell className="hidden py-3 align-top text-muted-foreground @md:table-cell">
        {modified}
      </TableCell>
      <TableCell className="py-3 text-right align-top tabular-nums">{size}</TableCell>
      {actions ? (
        <TableCell className="text-right align-top">
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${target.name}`} />
              }
            >
              <EllipsisIcon />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem variant="destructive" onClick={() => actions.onDelete(target)}>
                <Trash2Icon />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </TableCell>
      ) : null}
    </TableRow>
  );
}
