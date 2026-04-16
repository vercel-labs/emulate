"use client";

import { useActionState } from "react";
import { verifyCodeAction } from "../actions";
import { Button } from "@/components/ui/button";

export function VerifyForm() {
  const [state, formAction, pending] = useActionState(verifyCodeAction, null);

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <label htmlFor="code" className="text-sm font-medium">
        Verification code
      </label>
      <input
        id="code"
        name="code"
        type="text"
        inputMode="numeric"
        pattern="[0-9]{6}"
        maxLength={6}
        required
        autoFocus
        placeholder="000000"
        className="flex h-12 w-full rounded-lg border border-input bg-background px-3 py-1 text-center text-2xl font-mono tracking-[0.3em] transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      {state?.error && <p className="text-sm text-destructive text-center">{state.error}</p>}
      <Button type="submit" size="lg" disabled={pending} className="w-full">
        {pending ? "Verifying..." : "Verify"}
      </Button>
    </form>
  );
}
