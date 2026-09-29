import { Link, type LinkProps, useMatchRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";

import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";

export interface NavItem {
  title: string;
  /** The console route; absent while the page is still to come. */
  to?: LinkProps["to"];
  icon: ReactNode;
}

export function NavMain({ items }: { items: NavItem[] }) {
  return (
    <SidebarGroup>
      <SidebarGroupContent className="flex flex-col gap-2">
        <SidebarMenu>
          {items.map((item) => (
            <SidebarMenuItem key={item.title}>
              <NavButton item={item} tooltip={item.title} />
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

/**
 * One sidebar entry: a link when its page exists, and a disabled button
 * holding its place until then.
 */
export function NavButton({ item, tooltip }: { item: NavItem; tooltip?: string }) {
  const matchRoute = useMatchRoute();

  if (item.to === undefined) {
    return (
      <SidebarMenuButton tooltip={tooltip} disabled>
        {item.icon}
        <span>{item.title}</span>
      </SidebarMenuButton>
    );
  }

  return (
    <SidebarMenuButton
      tooltip={tooltip}
      isActive={Boolean(matchRoute({ to: item.to }))}
      render={<Link to={item.to} />}
    >
      {item.icon}
      <span>{item.title}</span>
    </SidebarMenuButton>
  );
}
