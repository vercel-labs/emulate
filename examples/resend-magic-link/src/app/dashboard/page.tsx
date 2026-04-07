import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { signOutAction } from "../actions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export default async function DashboardPage() {
  const session = await getSession();
  if (!session) redirect("/");

  return (
    <div className="flex flex-1 items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">Welcome</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 items-center">
          <p className="text-sm text-muted-foreground">
            Signed in as <strong className="text-foreground">{session.email}</strong>
          </p>
          <form action={signOutAction}>
            <Button variant="outline" size="lg">
              Sign out
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
