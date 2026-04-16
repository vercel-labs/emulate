import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { getProviders } from "@/lib/providers";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { buttonVariants } from "@/components/ui/button-variants";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

export default async function Dashboard() {
  const session = await getSession();
  if (!session) redirect("/");

  const providers = getProviders();
  const provider = providers[session.provider];
  const initials = (session.user.name ?? "?")
    .split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);

  return (
    <div className="flex flex-1 items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">Dashboard</CardTitle>
          <CardDescription>
            You&apos;re signed in via <Badge variant="secondary">{provider?.name ?? session.provider}</Badge>
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex items-center gap-4">
            <Avatar className="size-14">
              <AvatarFallback className="text-lg">{initials}</AvatarFallback>
            </Avatar>
            <div className="min-w-0">
              <p className="font-semibold text-lg truncate">{session.user.name}</p>
              {session.user.login && <p className="text-sm text-muted-foreground truncate">@{session.user.login}</p>}
              <p className="text-sm text-muted-foreground truncate">{session.user.email}</p>
            </div>
          </div>

          <Separator />

          <div className="space-y-2">
            <p className="text-sm font-medium text-muted-foreground">Access Token</p>
            <code className="block text-xs bg-muted rounded-md p-3 break-all font-mono">{session.accessToken}</code>
          </div>

          <Separator />

          <div className="flex gap-3">
            {Object.values(providers)
              .filter((p) => p.slug !== session.provider)
              .map((p) => (
                <a
                  key={p.slug}
                  href={`/api/auth/${p.slug}`}
                  className={cn(buttonVariants({ variant: "outline" }), "flex-1")}
                >
                  Switch to {p.name}
                </a>
              ))}
          </div>

          <form action="/api/auth/signout" method="post">
            <Button variant="destructive" className="w-full">
              Sign Out
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
