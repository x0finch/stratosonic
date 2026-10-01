import { EllipsisIcon, KeyRoundIcon, PencilIcon, Trash2Icon } from "lucide-react";

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
import type { SubsonicUser } from "@/lib/api";
import { formatDay, formatLastAccess } from "@/lib/subsonic-users";

/** What a row's menu can open, for one user. */
export type UserAction = "edit" | "password" | "delete";

/**
 * The Subsonic users, in the server's order (case-insensitive by name), each
 * with a **Subsonic admin** badge if they are one, when they were created
 * and when a client last signed in as them. `onAction` is absent for a role
 * that may not change them, and so is each row's menu. On a narrow screen
 * the dates give way, and the name and the role stay.
 */
export function UsersTable({
  users,
  onAction,
}: {
  users: readonly SubsonicUser[];
  onAction?: (action: UserAction, user: SubsonicUser) => void;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Username</TableHead>
          <TableHead>Role</TableHead>
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
            <TableCell className="hidden text-muted-foreground md:table-cell">
              {formatDay(user.createdAt)}
            </TableCell>
            <TableCell className="hidden text-muted-foreground sm:table-cell">
              {formatLastAccess(user.lastAccessAt)}
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
