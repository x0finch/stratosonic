import { Link } from "@tanstack/react-router";
import {
  AudioWaveformIcon,
  FolderIcon,
  LayoutDashboardIcon,
  LibraryIcon,
  UsersIcon,
} from "lucide-react";
import type { ComponentProps } from "react";

import { type NavItem, NavMain } from "@/components/nav-main";
import { NavUser } from "@/components/nav-user";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import type { Me } from "@/lib/api";
import { can } from "@/lib/roles";

// Only the pages that exist (#128): each coming admin phase adds its own
// entry with its page (#80).
const navMain: NavItem[] = [
  { title: "Overview", to: "/", icon: <LayoutDashboardIcon /> },
  { title: "Users", to: "/users", icon: <UsersIcon />, permission: "subsonic-users:read" },
  { title: "Files", to: "/files", icon: <FolderIcon />, permission: "files:read" },
  { title: "Libraries", to: "/libraries", icon: <LibraryIcon />, permission: "libraries:read" },
];

/** Whether the signed-in console user's role grants what an entry's page needs. */
function allowed(user: Me, item: NavItem): boolean {
  return item.permission === undefined || can(user, item.permission);
}

/**
 * The sidebar-08 block's inset sidebar: the console's name in the header,
 * its pages, and the signed-in user in the footer. The block's projects
 * group has no counterpart here, nor, until a page belongs there, its
 * secondary entries.
 */
export function AppSidebar({ user, ...props }: ComponentProps<typeof Sidebar> & { user: Me }) {
  return (
    <Sidebar variant="inset" {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" render={<Link to="/" />}>
              <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
                <AudioWaveformIcon className="size-4" />
              </div>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-medium">Stratosonic</span>
                <span className="truncate text-xs">Console</span>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <NavMain items={navMain.filter((item) => allowed(user, item))} />
      </SidebarContent>
      <SidebarFooter>
        <NavUser user={user} />
      </SidebarFooter>
    </Sidebar>
  );
}
