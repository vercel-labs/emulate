import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PhoneForm } from "./phone-form";

export default async function Home() {
  const session = await getSession();
  if (session) redirect("/dashboard");

  return (
    <div className="flex flex-1 items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">Verify your phone</CardTitle>
          <CardDescription>Enter your phone number to receive a verification code by SMS</CardDescription>
        </CardHeader>
        <CardContent>
          <PhoneForm />
        </CardContent>
      </Card>
    </div>
  );
}
