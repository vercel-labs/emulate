"use client";

import { useActionState } from "react";
import { sendCodeAction } from "./actions";
import { Button } from "@/components/ui/button";

export function PhoneForm() {
  const [state, formAction, pending] = useActionState(sendCodeAction, null);

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <label htmlFor="phone" className="text-sm font-medium">
        Phone number
      </label>
      <input
        id="phone"
        name="phone"
        type="tel"
        required
        defaultValue="+15555550123"
        placeholder="+15555550123"
        className="flex h-9 w-full rounded-lg border border-input bg-background px-3 py-1 text-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      {state?.error && <p className="text-sm text-destructive">{state.error}</p>}
      <Button type="submit" size="lg" disabled={pending} className="w-full mt-1">
        {pending ? "Sending..." : "Send verification code"}
      </Button>
    </form>
  );
}
