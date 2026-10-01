import { Link, type LinkProps, useMatchRoute } from "@tanstack/react-router";
import type { ComponentProps, ReactNode } from "react";

import {
  SidebarGroup,
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

/**
 * The sidebar-08 block's nav-main. No console page has subpages yet, so the
 * block's collapsible subitems, and the group label above them, are left out.
 */
export function NavMain({ items }: { items: NavItem[] }) {
  return (
    <SidebarGroup>
      <SidebarMenu>
        {items.map((item) => (
          <SidebarMenuItem key={item.title}>
            <NavButton item={item} tooltip={item.title} />
          </SidebarMenuItem>
        ))}
      </SidebarMenu>
    </SidebarGroup>
  );
}

/**
 * One sidebar entry: a link when its page exists, and a disabled button
 * holding its place until then.
 */
export function NavButton({
  item,
  tooltip,
  size,
}: {
  item: NavItem;
  tooltip?: string;
  size?: ComponentProps<typeof SidebarMenuButton>["size"];
}) {
  const matchRoute = useMatchRoute();

  // No tooltip on a placeholder: a disabled button takes no pointer events to
  // show one on, and the tooltip trigger would drop the `disabled` it needs.
  if (item.to === undefined) {
    return (
      <SidebarMenuButton size={size} disabled>
        {item.icon}
        <span>{item.title}</span>
      </SidebarMenuButton>
    );
  }

  return (
    <SidebarMenuButton
      size={size}
      tooltip={tooltip}
      isActive={Boolean(matchRoute({ to: item.to }))}
      render={<Link to={item.to} />}
    >
      {item.icon}
      <span>{item.title}</span>
    </SidebarMenuButton>
  );
}
