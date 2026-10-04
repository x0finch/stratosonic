import { EllipsisIcon, KeyRoundIcon, PencilIcon, Trash2Icon } from "lucide-react";

import { RelativeTime } from "@/components/relative-time";
import { Badge } from "@/components/ui/badge";
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
import type { LibraryName, SubsonicUser } from "@/lib/api";
import { formatDay, librariesLabel } from "@/lib/subsonic-users";

/** What a row's menu can open, for one user. */
export type UserAction = "edit" | "password" | "delete";

/**
 * The Subsonic users, in the server's order (case-insensitive by name), each
 * with a **Subsonic admin** badge if they are one, when they were created
 * and when a client last signed in as them, as a relative time from `now`
 * ("2 minutes ago", or "Never"), as the Overview writes its recent events
 * (#128). `onAction` is absent for a role that may not change them, and so
 * is each row's menu. On a narrow screen the dates give way, and the name
 * and the role stay.
 *
 * `libraries`, given only where more than one library exists (#84), adds a
 * Libraries column: "All" for a Subsonic admin, otherwise the names, or "3
 * libraries" past two. It is secondary, and hides on a phone.
 */
export function UsersTable({
  users,
  libraries,
  now,
  onAction,
}: {
  users: readonly SubsonicUser[];
  libraries?: readonly LibraryName[];
  now: number;
  onAction?: (action: UserAction, user: SubsonicUser) => void;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Username</TableHead>
          <TableHead>Role</TableHead>
          {libraries ? <TableHead className="hidden sm:table-cell">Libraries</TableHead> : null}
          <TableHead className="hidden md:table-cell">Created</TableHead>
          <TableHead className="hidden sm:table-cell">Last access</TableHead>
          {onAction && (
            <TableHead className="w-0">
              <span className="sr-only">Actions</span>
            </TableHead>
          )}
        </TableRow>
      </TableHeader>
      <TableBody>
        {users.map((user) => (
          <TableRow key={user.id}>
            <TableCell className="max-w-48 truncate font-medium">{user.username}</TableCell>
            <TableCell>
              {user.isAdmin ? (
                <Badge>Subsonic admin</Badge>
              ) : (
                <span className="text-muted-foreground">User</span>
              )}
            </TableCell>
            {libraries ? (
              <TableCell className="hidden max-w-64 truncate sm:table-cell">
                <span title={librariesLabel(user, libraries)}>
                  {librariesLabel(user, libraries)}
                </span>
              </TableCell>
            ) : null}
            <TableCell className="hidden text-muted-foreground md:table-cell">
              {formatDay(user.createdAt)}
            </TableCell>
            <TableCell className="hidden text-muted-foreground sm:table-cell">
              {user.lastAccessAt === null ? (
                "Never"
              ) : (
                <RelativeTime iso={user.lastAccessAt} now={now} />
              )}
            </TableCell>
            {onAction && (
              <TableCell className="text-right">
                <UserMenu user={user} onAction={onAction} />
              </TableCell>
            )}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function UserMenu({
  user,
  onAction,
}: {
  user: SubsonicUser;
  onAction: (action: UserAction, user: SubsonicUser) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${user.username}`} />
        }
      >
        <EllipsisIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => onAction("edit", user)}>
          <PencilIcon />
          Edit
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => onAction("password", user)}>
          <KeyRoundIcon />
          Set password
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onClick={() => onAction("delete", user)}>
          <Trash2Icon />
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
