import { listWebhooks } from "@/lib/webhook-log";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const sinceParam = url.searchParams.get("since");
  const since = sinceParam ? Number(sinceParam) : 0;
  return Response.json({ entries: listWebhooks(Number.isFinite(since) ? since : 0) });
}
