import { type ErrorComponentProps, useRouter } from "@tanstack/react-router";

import { AuthLayout } from "@/components/auth-layout";
import { ErrorAlert } from "@/components/error-alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * What the console shows when it cannot load at all, e.g. a Worker without
 * its encryption key or a plain-http origin: the reason, and a retry. It is
 * the whole page, so it stays on the page rather than in a toast.
 */
export function ErrorScreen({ error }: ErrorComponentProps) {
  const router = useRouter();

  return (
    <AuthLayout>
      <Card>
        <CardHeader>
          <CardTitle>Stratosonic</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <ErrorAlert error={error} />
          <Button variant="outline" onClick={() => router.invalidate()}>
            Try again
          </Button>
        </CardContent>
      </Card>
    </AuthLayout>
  );
}
