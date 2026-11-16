import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/oauth/session";

export async function POST(request: Request) {
  const response = NextResponse.redirect(new URL("/oauth", request.url));
  response.cookies.set(SESSION_COOKIE, "", { maxAge: 0, path: "/" });
  return response;
}
