import { cookies } from "next/headers";
import { encodePendingVerification, PENDING_COOKIE } from "@/lib/twilio/session";
import { twilioClient, VERIFY_SERVICE_SID } from "@/lib/twilio/twilio";

export async function startSmsVerification(phone: string) {
  await twilioClient.verify.v2.services(VERIFY_SERVICE_SID).verifications.create({
    to: phone,
    channel: "sms",
  });

  const cookieStore = await cookies();
  cookieStore.set(PENDING_COOKIE, encodePendingVerification({ phone, expiresAt: Date.now() + 10 * 60 * 1000 }), {
    httpOnly: true,
    path: "/",
    maxAge: 600,
  });
}
