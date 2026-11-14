import { forward, refuseForeign } from "@/lib/proxy";

const prefix = `http://localhost:${process.env.PORT ?? "3000"}/emulate/ai`;

async function handler(req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  const refusal = refuseForeign(req);
  if (refusal) return refusal;
  const { path } = await ctx.params;
  const url = new URL(req.url);
  return forward(req, `${prefix}/v1/${path.join("/")}${url.search}`);
}

export { handler as GET, handler as POST, handler as PUT, handler as PATCH, handler as DELETE };
