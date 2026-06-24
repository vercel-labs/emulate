"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { twilioClient, VERIFY_SERVICE_SID } from "@/lib/twilio";
import { encodeSession, getPendingVerification } from "@/lib/session";
import { startSmsVerification } from "@/lib/verification";

export async function sendCodeAction(_prev: { error: string } | null, formData: FormData) {
  const phone = (formData.get("phone") as string)?.trim();
  if (!phone) return { error: "Phone number is required" };

  try {
    await startSmsVerification(phone);
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Failed to send verification code" };
  }

  redirect("/verify");
}

export async function verifyCodeAction(_prev: { error: string } | null, formData: FormData) {
  const code = (formData.get("code") as string)?.trim();
  if (!code) return { error: "Code is required" };

  const pending = await getPendingVerification();
  if (!pending) return { error: "No pending verification. Please start over." };

  let approved = false;
  try {
    const check = await twilioClient.verify.v2.services(VERIFY_SERVICE_SID).verificationChecks.create({
      to: pending.phone,
      code,
    });
    approved = check.status === "approved";
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Failed to verify code" };
  }

  if (!approved) return { error: "Invalid code. Please try again." };

  const cookieStore = await cookies();
  cookieStore.delete("pending_verification");
  cookieStore.set("session", encodeSession({ phone: pending.phone, verifiedAt: new Date().toISOString() }), {
    httpOnly: true,
    path: "/",
    maxAge: 86400,
  });

  redirect("/dashboard");
}

export async function signOutAction() {
  const cookieStore = await cookies();
  cookieStore.delete("session");
  redirect("/");
}
