import { redirect } from "next/navigation";
import { getSession, getPendingSignIn } from "@/lib/session";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { VerifyForm } from "./verify-form";

export default async function VerifyPage() {
  const session = await getSession();
  if (session) redirect("/dashboard");

  const pending = await getPendingSignIn();
  if (!pending) redirect("/");

  return (
    <div className="flex flex-1 items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">Check your email</CardTitle>
          <CardDescription>
            We sent a 6-digit code to <strong className="text-foreground">{pending.email}</strong>
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <VerifyForm />
          <div className="rounded-lg border border-dashed border-border bg-muted/50 p-3 text-center">
            <p className="text-xs text-muted-foreground mb-2">
              Using the emulator? View the email in the inbox:
            </p>
            <a
              href="/emulate/resend/inbox"
              target="_blank"
              className="text-sm font-medium text-primary underline underline-offset-4 hover:text-primary/80"
            >
              Open Resend Inbox
            </a>
          </div>
          <a href="/" className="text-sm text-center text-muted-foreground hover:text-foreground transition-colors">
            Use a different email
          </a>
        </CardContent>
      </Card>
    </div>
  );
}
