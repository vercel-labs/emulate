import { cookies } from "next/headers";
import { encodePendingVerification } from "@/lib/session";
import { twilioClient, VERIFY_SERVICE_SID } from "@/lib/twilio";

export async function startSmsVerification(phone: string) {
  await twilioClient.verify.v2.services(VERIFY_SERVICE_SID).verifications.create({
    to: phone,
    channel: "sms",
  });

  const cookieStore = await cookies();
  cookieStore.set(
    "pending_verification",
    encodePendingVerification({ phone, expiresAt: Date.now() + 10 * 60 * 1000 }),
    {
      httpOnly: true,
      path: "/",
      maxAge: 600,
    },
  );
}
