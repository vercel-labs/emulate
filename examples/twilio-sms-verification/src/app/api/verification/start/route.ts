import { NextResponse } from "next/server";
import { startSmsVerification } from "@/lib/verification";

async function phoneFromRequest(request: Request): Promise<string | null> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const body = (await request.json()) as { phone?: unknown };
    return typeof body.phone === "string" ? body.phone.trim() : null;
  }

  const formData = await request.formData();
  const phone = formData.get("phone");
  return typeof phone === "string" ? phone.trim() : null;
}

export async function POST(request: Request) {
  const phone = await phoneFromRequest(request);
  if (!phone) {
    return NextResponse.json({ error: "Phone number is required" }, { status: 400 });
  }

  try {
    await startSmsVerification(phone);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to send verification code" },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true, phone, next: "/verify" });
}
