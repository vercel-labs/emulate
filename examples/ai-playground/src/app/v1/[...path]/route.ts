const prefix = `http://localhost:${process.env.PORT ?? "3000"}/emulate/ai`;

async function handler(req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  const url = new URL(req.url);
  const res = await fetch(`${prefix}/v1/${path.join("/")}${url.search}`, {
    method: req.method,
    headers: req.headers,
    body: req.body,
    duplex: "half",
  } as RequestInit & { duplex: string });

  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: res.headers });
}

export { handler as GET, handler as POST, handler as PUT, handler as PATCH, handler as DELETE };
