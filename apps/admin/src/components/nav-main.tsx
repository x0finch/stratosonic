import { Link, type LinkProps, useMatchRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";

import {
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";

export interface NavItem {
  title: string;
  /** The console route. The sidebar lists only pages that exist (#128). */
  to: LinkProps["to"];
  icon: ReactNode;
  /** The permission its page needs; without it, the entry is left out. */
  permission?: string;
}

/**
 * The sidebar-08 block's nav-main. No console page has subpages yet, so the
 * block's collapsible subitems, and the group label above them, are left out.
 */
export function NavMain({ items }: { items: NavItem[] }) {
  const matchRoute = useMatchRoute();

  return (
    <SidebarGroup>
      <SidebarMenu>
        {items.map((item) => (
          <SidebarMenuItem key={item.title}>
            <SidebarMenuButton
              tooltip={item.title}
              isActive={Boolean(matchRoute({ to: item.to }))}
              render={<Link to={item.to} />}
            >
              {item.icon}
              <span>{item.title}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        ))}
      </SidebarMenu>
    </SidebarGroup>
  );
}
