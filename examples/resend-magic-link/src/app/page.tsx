import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SignInForm } from "./sign-in-form";

export default async function Home() {
  const session = await getSession();
  if (session) redirect("/dashboard");

  return (
    <div className="flex flex-1 items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">Sign In</CardTitle>
          <CardDescription>Enter your email to receive a magic sign-in code</CardDescription>
        </CardHeader>
        <CardContent>
          <SignInForm />
        </CardContent>
      </Card>
    </div>
  );
}
