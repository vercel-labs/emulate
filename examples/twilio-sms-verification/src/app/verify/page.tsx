import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession, getPendingVerification } from "@/lib/session";
import { SEEDED_VERIFY_CODE } from "@/lib/twilio";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { VerifyForm } from "./verify-form";

export default async function VerifyPage() {
  const session = await getSession();
  if (session) redirect("/dashboard");

  const pending = await getPendingVerification();
  if (!pending) redirect("/");

  return (
    <div className="flex flex-1 items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">Enter the code</CardTitle>
          <CardDescription>
            We sent a 6-digit code to <strong className="text-foreground">{pending.phone}</strong>
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <VerifyForm />
          <div className="rounded-lg border border-dashed border-border bg-muted/50 p-3 text-center">
            <p className="text-xs text-muted-foreground mb-2">
              No SMS is actually sent. The emulator&apos;s seeded Verify Service always accepts the code{" "}
              <code className="font-mono font-medium text-foreground">{SEEDED_VERIFY_CODE}</code>.
            </p>
            <a
              href="/emulate/twilio/?tab=verify"
              target="_blank"
              className="text-sm font-medium text-primary underline underline-offset-4 hover:text-primary/80"
            >
              Open Twilio Inspector
            </a>
          </div>
          <Link href="/" className="text-sm text-center text-muted-foreground hover:text-foreground transition-colors">
            Use a different number
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}
