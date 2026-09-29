import { Link, type LinkProps } from "@tanstack/react-router";
import { InfoIcon } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * What a setup screen shows instead of its form when `GET /api/setup` says the
 * token cannot be used for it, with the ways on.
 */
export function SetupNotice({
  heading,
  title,
  description,
  links,
}: {
  heading: string;
  title: string;
  description: string;
  links: { to: LinkProps["to"]; label: string }[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{heading}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Alert>
          <InfoIcon />
          <AlertTitle>{title}</AlertTitle>
          <AlertDescription>{description}</AlertDescription>
        </Alert>
        {links.map(({ to, label }, index) => (
          <Button
            key={label}
            variant={index === 0 ? "default" : "outline"}
            nativeButton={false}
            render={<Link to={to} />}
          >
            {label}
          </Button>
        ))}
      </CardContent>
    </Card>
  );
}
