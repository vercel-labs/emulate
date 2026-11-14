import { NextResponse, type NextRequest } from "next/server";

/**
 * Refuses a page load that another site started, so only a direct visit can apply rules on load.
 * Framing is blocked separately by the frame-ancestors policy in next.config.ts.
 */
export default function proxy(request: NextRequest) {
  const destination = request.headers.get("sec-fetch-dest");
  const site = request.headers.get("sec-fetch-site");
  const framed = destination === "iframe" || destination === "frame";
  if (framed || (destination === "document" && site === "cross-site")) {
    return new NextResponse("Open this page directly on localhost to use the playground.", {
      status: 403,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  return NextResponse.next();
}

export const config = { matcher: ["/"] };
