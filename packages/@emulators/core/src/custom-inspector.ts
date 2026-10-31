import { Hono, type RouteInfo } from "./http.js";
import { registerFontRoutes } from "./fonts.js";
import { escapeHtml, escapeAttr, renderInspectorPage, renderJsonDetails, renderStateView } from "./ui.js";

export interface InspectorOptions {
  maxRequests?: number;
  maxBodyBytes?: number;
  redact?: string[];
}

interface Trace {
  id: number;
  method: string;
  path: string;
  status?: number;
  duration?: number;
  route?: string;
  error?: string;
  request: { headers: Record<string, string>; body?: unknown };
  response?: { headers: Record<string, string>; body?: unknown };
}

export function createCustomInspector(name: string, baseUrl: string, options: InspectorOptions) {
  for (const key of Object.keys(options))
    if (!["maxRequests", "maxBodyBytes", "redact"].includes(key)) throw new Error(`Unknown inspector option: ${key}`);
  for (const key of ["maxRequests", "maxBodyBytes"] as const)
    if (
      options[key] !== undefined &&
      (!Number.isSafeInteger(options[key]) || options[key]! < (key === "maxRequests" ? 1 : 0))
    )
      throw new Error(`inspector.${key} must be ${key === "maxRequests" ? "a positive" : "a nonnegative"} integer`);
  if (
    options.redact !== undefined &&
    (!Array.isArray(options.redact) || options.redact.some((key) => typeof key !== "string"))
  )
    throw new Error("inspector.redact must be an array of field names");
  const maxRequests = Math.max(1, Math.min(options.maxRequests ?? 100, 1000));
  const maxBytes = Math.max(0, Math.min(options.maxBodyBytes ?? 8192, 65536));
  const sensitive = new Set([
    "authorization",
    "proxy-authorization",
    "cookie",
    "set-cookie",
    "password",
    "secret",
    "token",
    "api_key",
    "apikey",
    "private_key",
    ...(options.redact ?? []).map((s) => s.toLowerCase()),
  ]);
  function isSensitive(key: string): boolean {
    if (sensitive.has(key.toLowerCase())) return true;
    const normalized = key
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .replace(/[-\s]/g, "_")
      .toLowerCase();
    return sensitive.has(normalized) || /(?:^|_)(?:token|secret|password|api_key|private_key|cookie)$/.test(normalized);
  }
  const traces: Trace[] = [];
  const active = new WeakMap<Request, { trace: Trace; start: number; preview: Promise<unknown>; epoch: number }>();
  let epoch = 0;
  let nextId = 1;
  const assets = new Hono();
  registerFontRoutes(assets);
  const root = `${baseUrl}/_emulate`;
  function redact(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(redact);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, isSensitive(key) ? "[redacted]" : redact(item)]),
    );
  }
  function headers(value: Headers): Record<string, string> {
    return Object.fromEntries(
      [...value].map(([key, val]) => [key, isSensitive(key) ? "[redacted]" : val.slice(0, maxBytes)]),
    );
  }
  async function preview(value: Request | Response): Promise<unknown> {
    if (!value.body || maxBytes === 0) return undefined;
    const type = value.headers.get("content-type") ?? "";
    if (!/application\/(json|[^;]+\+json)|text\/(plain|html)|application\/x-www-form-urlencoded/.test(type))
      return `[${type || "binary/streaming"} body omitted]`;
    if (Number(value.headers.get("content-length")) > maxBytes) return "[body exceeds preview limit]";
    const reader = value.clone().body!.getReader();
    const parts: Uint8Array[] = [];
    let size = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const bytes = await Promise.race([
        (async () => {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.length;
            if (size > maxBytes) throw new Error("limit");
            parts.push(chunk.value);
          }
          return Buffer.concat(parts);
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("stream")), 50);
        }),
      ]);
      const text = bytes.toString("utf8");
      if (type.includes("json")) {
        try {
          return redact(JSON.parse(text));
        } catch {
          return "[invalid JSON omitted]";
        }
      }
      if (type.includes("x-www-form-urlencoded")) return redact(Object.fromEntries(new URLSearchParams(text)));
      return text;
    } catch {
      return "[large or streaming body omitted]";
    } finally {
      clearTimeout(timer);
      void reader.cancel().catch(() => {});
    }
  }
  function safePath(url: URL): string {
    for (const key of [...url.searchParams.keys()]) if (isSensitive(key)) url.searchParams.set(key, "[redacted]");
    return `${url.pathname}${url.search}`;
  }
  const api = {
    clear() {
      epoch++;
      traces.length = 0;
    },
    begin(request: Request, route?: RouteInfo): number {
      const trace: Trace = {
        id: nextId++,
        method: request.method,
        path: safePath(new URL(request.url)),
        route: route?.path,
        request: { headers: headers(request.headers) },
      };
      active.set(request, { trace, start: performance.now(), preview: preview(request), epoch });
      return trace.id;
    },
    recordError(request: Request, error: unknown) {
      const entry = active.get(request);
      if (entry)
        entry.trace.error = (error instanceof Error ? (error.stack ?? error.message) : String(error)).slice(
          0,
          maxBytes,
        );
    },
    async finish(request: Request, response: Response, _started?: number) {
      const entry = active.get(request);
      if (!entry) return;
      entry.trace.duration = Math.round((performance.now() - entry.start) * 100) / 100;
      entry.trace.status = response.status;
      entry.trace.request.body = await entry.preview;
      entry.trace.response = { headers: headers(response.headers), body: await preview(response) };
      if (entry.epoch !== epoch) return;
      traces.push(entry.trace);
      if (traces.length > maxRequests) traces.splice(0, traces.length - maxRequests);
      active.delete(request);
    },
    async handle(
      request: Request,
      runtime: { snapshot(): unknown; reset(): Promise<void>; routes(): RouteInfo[] },
    ): Promise<Response> {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/_emulate/fonts/") || url.pathname === "/_emulate/favicon.ico")
        return assets.fetch(request);
      if (request.method === "POST" && url.pathname === "/_emulate/reset") {
        const origin = request.headers.get("origin");
        if (origin && origin !== new URL(baseUrl).origin)
          return Response.json({ error: "Origin does not match this emulator" }, { status: 403 });
        await runtime.reset();
        return new Response(null, { status: 303, headers: { Location: `${root}?tab=state` } });
      }
      if (request.method !== "GET" || (url.pathname !== "/_emulate" && url.pathname !== "/_emulate/"))
        return Response.json({ error: "Not Found" }, { status: 404 });
      const tab = ["requests", "routes", "state"].includes(url.searchParams.get("tab") ?? "")
        ? url.searchParams.get("tab")!
        : "requests";
      const tabs = ["requests", "routes", "state"].map((id) => ({
        id,
        label: id[0].toUpperCase() + id.slice(1),
        href: `${root}?tab=${id}`,
      }));
      let body = `<div class="s-card"><div class="s-title">${escapeHtml(name)}</div><p class="s-subtitle">${escapeHtml(baseUrl)}</p><form method="post" action="${escapeAttr(root)}/reset"><button type="submit" class="inspector-action">Reset to seed</button></form></div>`;
      if (tab === "state") body += renderStateView(redact((runtime.snapshot() as { state: unknown }).state));
      if (tab === "routes") {
        body += `<div class="inspector-scroll"><table class="inspector-table"><thead><tr><th>Method</th><th>Path</th><th>Request</th></tr></thead><tbody>${runtime
          .routes()
          .map((route) => {
            const target = `${baseUrl}${route.path.replace(/:([a-zA-Z0-9_]+)/g, "example")}`;
            const command = `curl -X ${route.method} '${target.replace(/'/g, "'\\''")}'`;
            return `<tr><td>${escapeHtml(route.method)}</td><td>${escapeHtml(route.path)}</td><td><code>${escapeHtml(command)}</code></td></tr>`;
          })
          .join("")}</tbody></table></div>`;
      }
      if (tab === "requests")
        body += traces.length
          ? [...traces]
              .reverse()
              .map((trace) =>
                renderJsonDetails(
                  `${trace.method} ${trace.path} · ${trace.status} · ${trace.duration} ms${trace.route ? "" : " · unmatched"}`,
                  trace,
                ),
              )
              .join("")
          : `<div class="empty">No API requests yet. Send a request to ${escapeHtml(baseUrl)} to see it here.</div>`;
      let html = renderInspectorPage(`${name} inspector`, tabs, tab, body, name);
      // Core assets use absolute paths; custom adapters can mount below a prefix.
      html = html.replaceAll('"/_emulate/', `"${root}/`).replaceAll("'/_emulate/", `'${root}/`);
      return new Response(html, {
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
      });
    },
  };
  return api;
}
