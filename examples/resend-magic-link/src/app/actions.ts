"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { resend } from "@/lib/resend";
import { encodePendingSignIn, encodeSession, generateCode, getPendingSignIn } from "@/lib/session";

export async function sendCodeAction(_prev: { error: string } | null, formData: FormData) {
  const email = formData.get("email") as string;
  if (!email) return { error: "Email is required" };

  const code = generateCode();
  const expiresAt = Date.now() + 10 * 60 * 1000;

  const { error } = await resend.emails.send({
    from: "auth@example.com",
    to: email,
    subject: "Your sign-in code",
    html: `
      <div style="font-family: sans-serif; max-width: 400px; margin: 0 auto; padding: 32px;">
        <h2 style="margin-bottom: 16px;">Sign in to your account</h2>
        <p style="color: #666; margin-bottom: 24px;">
          Use the code below to complete your sign-in. It expires in 10 minutes.
        </p>
        <div style="background: #f4f4f5; border-radius: 8px; padding: 20px; text-align: center; margin-bottom: 24px;">
          <span style="font-size: 32px; font-weight: bold; letter-spacing: 6px; font-family: monospace;">${code}</span>
        </div>
        <p style="color: #999; font-size: 13px;">
          If you did not request this code, you can safely ignore this email.
        </p>
      </div>
    `,
  });

  if (error) return { error: error.message };

  const cookieStore = await cookies();
  cookieStore.set("pending_signin", encodePendingSignIn({ email, code, expiresAt }), {
    httpOnly: true,
    path: "/",
    maxAge: 600,
  });

  redirect("/verify");
}

export async function verifyCodeAction(_prev: { error: string } | null, formData: FormData) {
  const code = formData.get("code") as string;
  if (!code) return { error: "Code is required" };

  const pending = await getPendingSignIn();
  if (!pending) return { error: "No pending sign-in. Please start over." };

  if (code !== pending.code) return { error: "Invalid code. Please try again." };

  const cookieStore = await cookies();
  cookieStore.delete("pending_signin");
  cookieStore.set(
    "session",
    encodeSession({ email: pending.email, signedInAt: new Date().toISOString() }),
    { httpOnly: true, path: "/", maxAge: 86400 },
  );

  redirect("/dashboard");
}

export async function signOutAction() {
  const cookieStore = await cookies();
  cookieStore.delete("session");
  redirect("/");
}
