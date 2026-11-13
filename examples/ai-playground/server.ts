import { readFile } from "node:fs/promises";
import { createServer, request, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createEmulator } from "emulate";

const ROOT = import.meta.dirname;
const PAGE = path.join(ROOT, "index.html");
const DEFAULT_EMULATOR_PORT = 4123;
const DEFAULT_PAGE_PORT = 8000;
const PROXIED = ["/v1/", "/_ai/", "/_emulate/fonts/"];
const RESPONSE_HEADERS = ["content-type", "retry-after", "x-request-id", "request-id"];

export interface PlaygroundOptions {
  port?: number;
  emulatorPort?: number;
}

export interface PlaygroundServer {
  readonly url: string;
  readonly emulatorUrl: string;
  close(): Promise<void>;
}

function sendJson(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ error: { message } }));
}

function isProxied(pathname: string): boolean {
  return PROXIED.some((prefix) => pathname.startsWith(prefix));
}

/** Returns why a request must be refused, so only this page on this machine can reach the emulator. */
function refusal(req: IncomingMessage, pathname: string, pagePort: number): string | null {
  const hosts = [`localhost:${pagePort}`, `127.0.0.1:${pagePort}`];
  if (!req.headers.host || !hosts.includes(req.headers.host)) {
    return `This playground only answers on localhost:${pagePort}.`;
  }
  if (!isProxied(pathname)) return null;
  const origins = hosts.map((host) => `http://${host}`);
  const origin = req.headers.origin;
  const site = req.headers["sec-fetch-site"];
  if (origin !== undefined && !origins.includes(origin)) {
    return "Other origins cannot use the emulator through the playground.";
  }
  if (site !== undefined && site !== "same-origin" && site !== "none") {
    return "Cross-site requests are not allowed.";
  }
  return null;
}

/** Forwards one request to the emulator and mirrors its reply, including a stream that is cut short. */
function proxy(req: IncomingMessage, res: ServerResponse, emulatorPort: number): void {
  const headers = req.headers["content-type"] ? { "content-type": req.headers["content-type"] } : {};
  const upstream = request(
    { host: "127.0.0.1", port: emulatorPort, method: req.method, path: req.url, headers },
    (reply) => {
      const kept = RESPONSE_HEADERS.filter((name) => reply.headers[name] !== undefined);
      const outHeaders: Record<string, string | string[] | undefined> = {};
      for (const name of kept) outHeaders[name] = reply.headers[name];
      res.writeHead(reply.statusCode ?? 502, outHeaders);
      reply.on("error", () => res.destroy());
      reply.on("close", () => {
        if (!reply.complete) res.destroy();
      });
      reply.pipe(res);
    },
  );
  upstream.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "ECONNREFUSED" && !res.headersSent) sendJson(res, 502, "The emulator is not reachable.");
    else res.destroy();
  });
  res.on("close", () => upstream.destroy());
  req.pipe(upstream);
}

async function servePage(res: ServerResponse): Promise<void> {
  try {
    const body = await readFile(PAGE);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(body);
  } catch {
    sendJson(res, 500, "Could not read index.html.");
  }
}

/** Starts the AI emulator and the same-origin playground HTTP server. */
export async function startPlayground(options: PlaygroundOptions = {}): Promise<PlaygroundServer> {
  const emulator = await createEmulator({ service: "ai", port: options.emulatorPort ?? DEFAULT_EMULATOR_PORT });
  const emulatorPort = Number(new URL(emulator.url).port);
  let pagePort = options.port ?? DEFAULT_PAGE_PORT;

  const server = createServer((req, res) => {
    const { pathname } = new URL(req.url ?? "/", `http://localhost:${pagePort}`);
    const reason = refusal(req, pathname, pagePort);
    if (reason) {
      sendJson(res, 403, reason);
      return;
    }
    if (isProxied(pathname)) {
      proxy(req, res, emulatorPort);
      return;
    }
    if (pathname === "/" || pathname === "/index.html") {
      void servePage(res);
      return;
    }
    sendJson(res, 404, "Not found.");
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(pagePort, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    await emulator.close();
    throw error;
  }

  pagePort = (server.address() as AddressInfo).port;
  return {
    url: `http://localhost:${pagePort}`,
    emulatorUrl: emulator.url,
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      await emulator.close();
    },
  };
}

function isEntrypoint(): boolean {
  return process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isEntrypoint()) {
  try {
    const playground = await startPlayground();
    console.log(`\n  Playground  ${playground.url}`);
    console.log(`  Emulator    ${playground.emulatorUrl}`);
    console.log("  Stop with Ctrl+C");

    const stop = async () => {
      await playground.close();
      process.exit(0);
    };
    process.on("SIGINT", () => void stop());
    process.on("SIGTERM", () => void stop());
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    const message =
      errno.code === "EADDRINUSE"
        ? `Port ${DEFAULT_PAGE_PORT} or ${DEFAULT_EMULATOR_PORT} is already in use. Stop the process using it and run this again.`
        : errno.message;
    console.error(message);
    process.exit(1);
  }
}
