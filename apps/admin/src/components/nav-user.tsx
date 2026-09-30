import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useRouter } from "@tanstack/react-router";
import { CircleUserRoundIcon, EllipsisVerticalIcon, LogOutIcon } from "lucide-react";

import { ErrorAlert } from "@/components/error-alert";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { type Me, meQuery, signOut } from "@/lib/api";
import { leaveSignedOut } from "@/lib/sign-out";

/** The first two characters of the name, for the avatar an operator has none of. */
function initials(name: string): string {
  return Array.from(name).slice(0, 2).join("").toUpperCase();
}

/**
 * The dashboard-01 block's nav-user: the signed-in operator's name, the
 * account page and sign-out. Operators have no avatar or email, so the avatar
 * is the name's initials and the second line says what kind of account it is:
 * an operator's, not a Subsonic user's.
 */
export function NavUser({ user }: { user: Me }) {
  const { isMobile } = useSidebar();
  const queryClient = useQueryClient();
  const router = useRouter();

  const logOut = useMutation({
    mutationFn: signOut,
    // Plain /login, with nothing left in the cache: the next sign-in lands on
    // the overview, not on the page this one left (lib/sign-out.ts).
    onSuccess: () => leaveSignedOut(queryClient, router),
    // Never shown as signed out while the session may live on: ask the server
    // who is signed in instead, and say above the menu that it failed.
    onError: () => queryClient.invalidateQueries({ queryKey: meQuery.queryKey }),
  });

  return (
    <SidebarMenu>
      {logOut.error && (
        <SidebarMenuItem>
          <ErrorAlert error={logOut.error} title="Sign-out failed" />
        </SidebarMenuItem>
      )}
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<SidebarMenuButton size="lg" className="aria-expanded:bg-muted" />}
          >
            <Avatar className="size-8 rounded-lg grayscale">
              <AvatarFallback className="rounded-lg">{initials(user.username)}</AvatarFallback>
            </Avatar>
            <div className="grid flex-1 text-left text-sm leading-tight">
              <span className="truncate font-medium">{user.username}</span>
              <span className="truncate text-xs text-foreground/70">Operator</span>
            </div>
            <EllipsisVerticalIcon className="ml-auto size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="min-w-56"
            side={isMobile ? "bottom" : "right"}
            align="end"
            sideOffset={4}
          >
            <DropdownMenuGroup>
              <DropdownMenuLabel className="p-0 font-normal">
                <div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
                  <Avatar className="size-8">
                    <AvatarFallback className="rounded-lg">
                      {initials(user.username)}
                    </AvatarFallback>
                  </Avatar>
                  <div className="grid flex-1 text-left text-sm leading-tight">
                    <span className="truncate font-medium">{user.username}</span>
                    <span className="truncate text-xs text-muted-foreground">Operator</span>
                  </div>
                </div>
              </DropdownMenuLabel>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem render={<Link to="/account" />}>
                <CircleUserRoundIcon />
                Account
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={logOut.isPending} onClick={() => logOut.mutate()}>
              <LogOutIcon />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
