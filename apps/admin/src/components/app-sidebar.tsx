import { Link } from "@tanstack/react-router";
import {
  AudioWaveformIcon,
  FolderIcon,
  LayoutDashboardIcon,
  LibraryIcon,
  ScanSearchIcon,
  Settings2Icon,
  UsersIcon,
} from "lucide-react";
import type { ComponentProps } from "react";

import { type NavItem, NavMain } from "@/components/nav-main";
import { NavSecondary } from "@/components/nav-secondary";
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

// The entries without a page hold the places of the pages the coming admin
// phases add (#80).
const data: { navMain: NavItem[]; navSecondary: NavItem[] } = {
  navMain: [
    { title: "Overview", to: "/", icon: <LayoutDashboardIcon /> },
    { title: "Library", icon: <LibraryIcon /> },
    { title: "Scans", icon: <ScanSearchIcon /> },
    { title: "Users", to: "/users", icon: <UsersIcon />, permission: "subsonic-users:read" },
    { title: "Files", icon: <FolderIcon /> },
  ],
  navSecondary: [{ title: "Settings", icon: <Settings2Icon /> }],
};

/** Whether the signed-in console user's role grants what an entry's page needs. */
function allowed(user: Me, item: NavItem): boolean {
  return item.permission === undefined || can(user, item.permission);
}

/**
 * The sidebar-08 block's inset sidebar: the console's name in the header,
 * its pages, the secondary entries at the bottom, and the signed-in user in
 * the footer. The block's projects group has no counterpart here.
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
        <NavMain items={data.navMain.filter((item) => allowed(user, item))} />
        <NavSecondary items={data.navSecondary} className="mt-auto" />
      </SidebarContent>
      <SidebarFooter>
        <NavUser user={user} />
      </SidebarFooter>
    </Sidebar>
  );
}
