import { type ErrorComponentProps, useRouter } from "@tanstack/react-router";
import { CircleAlertIcon } from "lucide-react";

import { AuthLayout } from "@/components/auth-layout";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { describeError } from "@/lib/errors";

/**
 * What the console shows when it cannot load at all, e.g. a Worker without
 * its encryption key or a plain-http origin: the reason, as the official
 * destructive alert, and a retry. It is the whole page, so it stays on the
 * page rather than in a toast.
 */
export function ErrorScreen({ error }: ErrorComponentProps) {
  const router = useRouter();
  const message = describeError(error);

  return (
    <AuthLayout>
      <Card>
        <CardHeader>
          <CardTitle>Stratosonic</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Alert variant="destructive">
            <CircleAlertIcon />
            <AlertTitle>{message.title}</AlertTitle>
            <AlertDescription>{message.description}</AlertDescription>
          </Alert>
          <Button variant="outline" onClick={() => router.invalidate()}>
            Try again
          </Button>
        </CardContent>
      </Card>
    </AuthLayout>
  );
}
