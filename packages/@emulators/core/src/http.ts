import { createServer as createNodeServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

type BodyInit = ConstructorParameters<typeof Response>[0];
type HeadersInit = ConstructorParameters<typeof Headers>[0];
type FormDataEntryValue = string | File;

export type ContentfulStatusCode = number;
export type Next = () => Promise<void>;

type VariablesOf<E> = unknown extends E
  ? Record<string, any>
  : E extends { Variables: infer V }
    ? V
    : Record<string, any>;
type HandlerResult = Response | void | Promise<Response | void>;

export type Handler<E = unknown, P extends string = string> = (c: Context<E, P>, next: Next) => HandlerResult;
export type MiddlewareHandler<E = unknown> = Handler<E>;
export type ErrorHandler<E = unknown> = (err: unknown, c: Context<E>) => Response | Promise<Response>;
export type FetchHandler = (request: Request) => Response | Promise<Response>;

interface CompiledPath {
  pattern: string;
  regex: RegExp;
  paramNames: string[];
}

interface Route<E> {
  method: string;
  compiled: CompiledPath;
  handlers: Handler<E>[];
}

interface MatchedHandler<E> {
  handler: Handler<E>;
  params: Record<string, string>;
}

export interface ServeOptions {
  fetch: FetchHandler;
  port?: number;
  hostname?: string;
}

export interface CorsOptions {
  origin?: string;
  allowMethods?: string[];
  allowHeaders?: string[];
  credentials?: boolean;
  maxAge?: number;
}

export class HonoRequest<P extends string = string> {
  readonly raw: Request;
  readonly url: string;
  readonly method: string;
  readonly path: string;

  constructor(
    request: Request,
    private readonly params: Record<string, string>,
  ) {
    this.raw = request;
    this.url = request.url;
    this.method = request.method;
    this.path = new URL(request.url).pathname;
  }

  header(): Record<string, string>;
  header(name: string): string | undefined;
  header(name?: string): Record<string, string> | string | undefined {
    if (name) return this.raw.headers.get(name) ?? undefined;
    const headers: Record<string, string> = {};
    this.raw.headers.forEach((value, key) => {
      headers[key] = value;
    });
    return headers;
  }

  query(name: string): string | undefined {
    return new URL(this.url).searchParams.get(name) ?? undefined;
  }

  queries(name: string): string[] | undefined {
    const values = new URL(this.url).searchParams.getAll(name);
    return values.length > 0 ? values : undefined;
  }

  param(): Record<string, string>;
  param(name: string): string;
  param(name?: string): Record<string, string> | string {
    if (!name) return { ...this.params };
    return this.params[name] ?? "";
  }

  json<T = any>(): Promise<T> {
    return this.raw.json() as Promise<T>;
  }

  text(): Promise<string> {
    return this.raw.text();
  }

  arrayBuffer(): Promise<ArrayBuffer> {
    return this.raw.arrayBuffer();
  }

  async parseBody(): Promise<Record<string, FormDataEntryValue | FormDataEntryValue[]>> {
    const contentType = this.header("Content-Type") ?? "";
    if (contentType.includes("multipart/form-data")) {
      return formDataToObject(await this.raw.formData());
    }
    if (contentType.includes("application/x-www-form-urlencoded")) {
      const params = new URLSearchParams(await this.raw.text());
      const out: Record<string, string | string[]> = {};
      for (const [key, value] of params) {
        appendBodyValue(out, key, value);
      }
      return out;
    }
    if (contentType.includes("application/json")) {
      const body = await this.raw.json().catch(() => ({}));
      return body && typeof body === "object" && !Array.isArray(body)
        ? (body as Record<string, FormDataEntryValue | FormDataEntryValue[]>)
        : {};
    }
    return {};
  }
}

export class Context<E = unknown, P extends string = string> {
  readonly req: HonoRequest<P>;
  private readonly vars = new Map<string, unknown>();
  private readonly responseHeaders = new Headers();
  private responseStatus = 200;

  constructor(
    request: Request,
    params: Record<string, string>,
    private readonly notFoundHandler: (c: Context<E>) => Response | Promise<Response>,
  ) {
    this.req = new HonoRequest<P>(request, params);
  }

  get<K extends keyof VariablesOf<E> & string>(key: K): VariablesOf<E>[K] | undefined {
    return this.vars.get(key) as VariablesOf<E>[K] | undefined;
  }

  set<K extends keyof VariablesOf<E> & string>(key: K, value: VariablesOf<E>[K]): void {
    this.vars.set(key, value);
  }

  header(name: string, value: string): void {
    this.responseHeaders.set(name, value);
  }

  status(status: number): void {
    this.responseStatus = status;
  }

  json(data: unknown, status?: ContentfulStatusCode, headers?: HeadersInit): Response {
    return this.response(JSON.stringify(data), status, defaultContentType(headers, "application/json; charset=UTF-8"));
  }

  text(text: string, status?: ContentfulStatusCode, headers?: HeadersInit): Response {
    return this.response(text, status, defaultContentType(headers, "text/plain; charset=UTF-8"));
  }

  html(html: string, status?: ContentfulStatusCode, headers?: HeadersInit): Response {
    return this.response(html, status, defaultContentType(headers, "text/html; charset=UTF-8"));
  }

  body(body: BodyInit | null, status?: ContentfulStatusCode, headers?: HeadersInit): Response {
    return this.response(body, status, headers);
  }

  redirect(location: string, status: ContentfulStatusCode = 302): Response {
    return this.response(null, status, { Location: location });
  }

  notFound(): Response | Promise<Response> {
    return this.notFoundHandler(this);
  }

  finalize(response: Response): Response {
    if (!hasHeaders(this.responseHeaders)) return response;
    const headers = new Headers(response.headers);
    this.responseHeaders.forEach((value, key) => {
      headers.set(key, value);
    });
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  private response(body: BodyInit | null, status?: ContentfulStatusCode, headers?: HeadersInit): Response {
    const merged = new Headers(headers);
    this.responseHeaders.forEach((value, key) => {
      merged.set(key, value);
    });
    return new Response(body, {
      status: status ?? this.responseStatus,
      headers: merged,
    });
  }
}

export class Hono<E = unknown> {
  private readonly middleware: Route<E>[] = [];
  private readonly routes: Route<E>[] = [];
  private errorHandler: ErrorHandler<E> = (err) => {
    const message = err instanceof Error ? err.message : "Internal Server Error";
    return new Response(message, { status: 500 });
  };
  private notFoundHandler: (c: Context<E>) => Response | Promise<Response> = () =>
    new Response("404 Not Found", { status: 404 });

  use<P extends string = string>(path: string, ...handlers: Handler<E, P>[]): this;
  use(...handlers: Handler<E>[]): this;
  use<P extends string = string>(pathOrHandler: string | Handler<E>, ...handlers: Handler<E, P>[]): this {
    if (typeof pathOrHandler === "string") {
      this.middleware.push({ method: "ALL", compiled: compilePath(pathOrHandler), handlers: handlers as Handler<E>[] });
    } else {
      this.middleware.push({ method: "ALL", compiled: compilePath("*"), handlers: [pathOrHandler, ...handlers] });
    }
    return this;
  }

  on<P extends string = string>(method: string, path: string, ...handlers: Handler<E, P>[]): this {
    this.routes.push({ method: method.toUpperCase(), compiled: compilePath(path), handlers: handlers as Handler<E>[] });
    return this;
  }

  get<P extends string = string>(path: string, ...handlers: Handler<E, P>[]): this {
    return this.on("GET", path, ...handlers);
  }

  post<P extends string = string>(path: string, ...handlers: Handler<E, P>[]): this {
    return this.on("POST", path, ...handlers);
  }

  put<P extends string = string>(path: string, ...handlers: Handler<E, P>[]): this {
    return this.on("PUT", path, ...handlers);
  }

  patch<P extends string = string>(path: string, ...handlers: Handler<E, P>[]): this {
    return this.on("PATCH", path, ...handlers);
  }

  delete<P extends string = string>(path: string, ...handlers: Handler<E, P>[]): this {
    return this.on("DELETE", path, ...handlers);
  }

  onError(handler: ErrorHandler<E>): this {
    this.errorHandler = handler;
    return this;
  }

  notFound(handler: (c: Context<E>) => Response | Promise<Response>): this {
    this.notFoundHandler = handler;
    return this;
  }

  async request(input: string | Request, init?: RequestInit): Promise<Response> {
    if (input instanceof Request) return this.fetch(input);
    const url = input.startsWith("/") ? `http://localhost${input}` : input;
    return this.fetch(new Request(url, init));
  }

  fetch = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method.toUpperCase();
    const matched = this.match(method, path);
    const context = new Context<E>(request, matched.params, this.notFoundHandler);

    try {
      const response = await this.dispatch(context, matched.handlers);
      return context.finalize(response ?? (await this.notFoundHandler(context)));
    } catch (err) {
      return context.finalize(await this.errorHandler(err, context));
    }
  };

  private match(method: string, path: string): { handlers: MatchedHandler<E>[]; params: Record<string, string> } {
    const handlers: MatchedHandler<E>[] = [];
    const params: Record<string, string> = {};

    for (const route of this.middleware) {
      const match = matchPath(route.compiled, path);
      if (!match) continue;
      Object.assign(params, match);
      for (const handler of route.handlers) {
        handlers.push({ handler, params: match });
      }
    }

    const route =
      this.routes.find((candidate) => candidate.method === method && matchPath(candidate.compiled, path) != null) ??
      (method === "HEAD"
        ? this.routes.find((candidate) => candidate.method === "GET" && matchPath(candidate.compiled, path) != null)
        : undefined);

    if (route) {
      const match = matchPath(route.compiled, path) ?? {};
      Object.assign(params, match);
      for (const handler of route.handlers) {
        handlers.push({ handler, params: match });
      }
    }

    return { handlers, params };
  }

  private async dispatch(context: Context<E>, handlers: MatchedHandler<E>[]): Promise<Response | void> {
    let index = -1;
    const run = async (nextIndex: number): Promise<Response | void> => {
      if (nextIndex <= index) throw new Error("next() called multiple times");
      index = nextIndex;
      const matched = handlers[nextIndex];
      if (!matched) return undefined;

      const originalParams = context.req.param();
      Object.assign(originalParams, matched.params);

      let nextResponse: Response | void = undefined;
      let nextCalled = false;
      const next: Next = async () => {
        nextCalled = true;
        nextResponse = await run(nextIndex + 1);
      };

      const response = await matched.handler(context, next);
      if (response instanceof Response) return response;
      if (nextCalled) return nextResponse;
      return response;
    };

    return run(0);
  }
}

export function cors(options: CorsOptions = {}): MiddlewareHandler {
  const origin = options.origin ?? "*";
  const allowMethods = options.allowMethods ?? ["GET", "HEAD", "PUT", "POST", "DELETE", "PATCH", "OPTIONS"];

  return async (c, next) => {
    c.header("Access-Control-Allow-Origin", origin);
    if (options.credentials) c.header("Access-Control-Allow-Credentials", "true");

    if (c.req.method.toUpperCase() === "OPTIONS") {
      c.header("Access-Control-Allow-Methods", allowMethods.join(","));
      const allowHeaders = options.allowHeaders?.join(",") ?? c.req.header("Access-Control-Request-Headers");
      if (allowHeaders) c.header("Access-Control-Allow-Headers", allowHeaders);
      if (options.maxAge != null) c.header("Access-Control-Max-Age", String(options.maxAge));
      return c.body(null, 204);
    }

    await next();
  };
}

export function serve(options: ServeOptions): Server {
  const port = options.port ?? 3000;
  const server = createNodeServer(async (req, res) => {
    try {
      const request = nodeRequestToFetchRequest(req);
      const response = await options.fetch(request);
      await writeFetchResponse(res, response, req.method?.toUpperCase() === "HEAD");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Internal Server Error";
      res.statusCode = 500;
      res.setHeader("Content-Type", "text/plain; charset=UTF-8");
      res.end(message);
    }
  });
  server.listen(port, options.hostname);
  return server;
}

function compilePath(pattern: string): CompiledPath {
  if (pattern === "*" || pattern === "/*") {
    return { pattern, regex: /^.*$/, paramNames: [] };
  }

  const paramNames: string[] = [];
  let source = "^";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char !== ":") {
      source += escapeRegex(char);
      continue;
    }

    let name = "";
    i++;
    while (i < pattern.length && /[A-Za-z0-9_]/.test(pattern[i])) {
      name += pattern[i];
      i++;
    }
    i--;
    paramNames.push(name);

    if (pattern[i + 1] === "{") {
      const close = pattern.indexOf("}", i + 2);
      if (close < 0) throw new Error(`Invalid route pattern: ${pattern}`);
      const expr = pattern.slice(i + 2, close);
      source += `(${expr})`;
      i = close;
    } else {
      source += "([^/]+)";
    }
  }
  source += "$";
  return { pattern, regex: new RegExp(source), paramNames };
}

function matchPath(compiled: CompiledPath, path: string): Record<string, string> | null {
  const match = compiled.regex.exec(path);
  if (!match) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < compiled.paramNames.length; i++) {
    params[compiled.paramNames[i]] = decodePathParam(match[i + 1] ?? "");
  }
  return params;
}

function decodePathParam(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&");
}

function hasHeaders(headers: Headers): boolean {
  for (const _ of headers) return true;
  return false;
}

function defaultContentType(headers: HeadersInit | undefined, contentType: string): Headers {
  const out = new Headers(headers);
  if (!out.has("Content-Type")) {
    out.set("Content-Type", contentType);
  }
  return out;
}

function formDataToObject(formData: FormData): Record<string, FormDataEntryValue | FormDataEntryValue[]> {
  const out: Record<string, FormDataEntryValue | FormDataEntryValue[]> = {};
  for (const [key, value] of formData) {
    appendBodyValue(out, key, value);
  }
  return out;
}

function appendBodyValue<T>(target: Record<string, T | T[]>, key: string, value: T): void {
  const existing = target[key];
  if (existing === undefined) {
    target[key] = value;
  } else if (Array.isArray(existing)) {
    existing.push(value);
  } else {
    target[key] = [existing, value];
  }
}

function nodeRequestToFetchRequest(req: IncomingMessage): Request {
  const host = req.headers.host ?? "localhost";
  const url = new URL(req.url ?? "/", `http://${host}`);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else {
      headers.set(key, value);
    }
  }

  const method = req.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";
  return new Request(url.toString(), {
    method,
    headers,
    body: hasBody ? (req as unknown as BodyInit) : undefined,
    duplex: "half",
  } as RequestInit & { duplex: string });
}

async function writeFetchResponse(res: ServerResponse, response: Response, headOnly: boolean): Promise<void> {
  res.statusCode = response.status;
  res.statusMessage = response.statusText;

  const headersWithCookies = response.headers as Headers & { getSetCookie?: () => string[] };
  const cookies = headersWithCookies.getSetCookie?.();
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() === "set-cookie" && cookies && cookies.length > 0) return;
    res.setHeader(key, value);
  });
  if (cookies && cookies.length > 0) {
    res.setHeader("Set-Cookie", cookies);
  }

  if (headOnly || !response.body) {
    res.end();
    return;
  }

  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(value)) {
        await new Promise<void>((resolve) => res.once("drain", resolve));
      }
    }
    res.end();
  } catch (err) {
    res.destroy(err instanceof Error ? err : undefined);
  }
}
