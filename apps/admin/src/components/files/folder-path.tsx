import { Link } from "@tanstack/react-router";
import { Fragment } from "react";

import {
  Breadcrumb,
  BreadcrumbEllipsis,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { folderTrail } from "@/lib/files";

/** A folder's search parameters: none for the root. */
export function folderSearch(prefix: string): { prefix?: string } {
  return prefix === "" ? {} : { prefix };
}

/**
 * Where the folder on screen is (#83, "Layout", item 1): the bucket, then
 * each folder down to this one, each a link but the last. In a narrow
 * column the folders between the bucket and this one collapse into the
 * breadcrumb's ellipsis, a menu of their links, as shadcn/ui's breadcrumb
 * example does.
 */
export function FolderPath({ prefix, bucket }: { prefix: string; bucket: string }) {
  const trail = folderTrail(prefix);
  const last = trail.at(-1);
  const middle = trail.slice(0, -1);

  return (
    <Breadcrumb aria-label="Folder path">
      <BreadcrumbList>
        <BreadcrumbItem>
          {last ? (
            <BreadcrumbLink render={<Link to="/files" search={{}} />}>{bucket}</BreadcrumbLink>
          ) : (
            <BreadcrumbPage>{bucket}</BreadcrumbPage>
          )}
        </BreadcrumbItem>
        {middle.length > 0 ? (
          <>
            <BreadcrumbSeparator className="@md:hidden" />
            <BreadcrumbItem className="@md:hidden">
              <DropdownMenu>
                <DropdownMenuTrigger
                  aria-label="Folders in between"
                  className="flex items-center rounded-md"
                >
                  <BreadcrumbEllipsis />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  {middle.map((folder) => (
                    <DropdownMenuItem
                      key={folder.prefix}
                      render={<Link to="/files" search={folderSearch(folder.prefix)} />}
                    >
                      {folder.name}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </BreadcrumbItem>
          </>
        ) : null}
        {middle.map((folder) => (
          <Fragment key={folder.prefix}>
            <BreadcrumbSeparator className="hidden @md:list-item" />
            <BreadcrumbItem className="hidden @md:inline-flex">
              <BreadcrumbLink render={<Link to="/files" search={folderSearch(folder.prefix)} />}>
                {folder.name}
              </BreadcrumbLink>
            </BreadcrumbItem>
          </Fragment>
        ))}
        {last ? (
          <>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>{last.name}</BreadcrumbPage>
            </BreadcrumbItem>
          </>
        ) : null}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
