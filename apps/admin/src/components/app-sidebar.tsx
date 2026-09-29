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
import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";

// Only the overview has a page so far; the other entries hold the places of
// the pages the coming admin phases add (#80).
const data: { navMain: NavItem[]; navSecondary: NavItem[] } = {
  navMain: [
    { title: "Overview", to: "/", icon: <LayoutDashboardIcon /> },
    { title: "Library", icon: <LibraryIcon /> },
    { title: "Scans", icon: <ScanSearchIcon /> },
    { title: "Users", icon: <UsersIcon /> },
    { title: "Files", icon: <FolderIcon /> },
  ],
  navSecondary: [{ title: "Settings", icon: <Settings2Icon /> }],
};

export function AppSidebar({ ...props }: ComponentProps<typeof Sidebar>) {
  return (
    <Sidebar collapsible="offcanvas" {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              className="data-[slot=sidebar-menu-button]:p-1.5!"
              render={<Link to="/" />}
            >
              <AudioWaveformIcon className="size-5!" />
              <span className="text-base font-semibold">Stratosonic</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <NavMain items={data.navMain} />
        <NavSecondary items={data.navSecondary} className="mt-auto" />
      </SidebarContent>
    </Sidebar>
  );
}
