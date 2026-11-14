const port = process.env.PORT ?? "3000";
const hosts = [`localhost:${port}`, `127.0.0.1:${port}`];
const origins = hosts.map((host) => `http://${host}`);
const dropped = /^(access-control-|connection$|keep-alive$|transfer-encoding$|content-length$|content-encoding$)/i;

const deny = (message: string) =>
  new Response(JSON.stringify({ error: { message } }), {
    status: 403,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

/** Refuses browser callers that are not this page on this machine, before their origin is stripped for the emulator. */
export function refuseForeign(req: Request): Response | null {
  const host = req.headers.get("host");
  if (!host || !hosts.includes(host)) return deny(`This playground only answers on localhost:${port}.`);
  const origin = req.headers.get("origin");
  if (origin !== null && !origins.includes(origin)) {
    return deny("Other origins cannot use the emulator through the playground.");
  }
  const site = req.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin" && site !== "none") {
    return deny("Cross-site requests are not allowed.");
  }
  return null;
}

/** Forwards a request to the emulator and returns its reply without the emulator's wildcard CORS headers. */
export async function forward(req: Request, target: string): Promise<Response> {
  const contentType = req.headers.get("content-type");
  const res = await fetch(target, {
    method: req.method,
    headers: contentType ? { "content-type": contentType } : {},
    body: req.method === "GET" || req.method === "DELETE" ? undefined : req.body,
    duplex: "half",
  } as RequestInit & { duplex: string });

  const headers = new Headers(res.headers);
  for (const name of [...headers.keys()]) {
    if (dropped.test(name)) headers.delete(name);
  }
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
