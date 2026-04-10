import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { writeFileSync } from "fs";
import { stringify as yamlStringify } from "yaml";
import pc from "picocolors";

export interface RecordOptions {
  port: number;
  upstream: string;
  service: string;
  output: string;
}

interface RecordedExchange {
  method: string;
  path: string;
  requestBody: string | null;
  responseStatus: number;
  responseBody: string;
}

function extractGitHubEntities(recordings: RecordedExchange[]): Record<string, unknown> {
  const users: Array<Record<string, unknown>> = [];
  const repos: Array<Record<string, unknown>> = [];
  const seenUsers = new Set<string>();
  const seenRepos = new Set<string>();

  for (const rec of recordings) {
    if (rec.responseStatus >= 400) continue;

    let body: Record<string, unknown>;
    try {
      body = JSON.parse(rec.responseBody);
    } catch {
      continue;
    }

    // Extract user from /user or /users/:login
    if ((rec.path === "/user" || rec.path.match(/^\/users\/[^/]+$/)) && body.login) {
      const login = String(body.login);
      if (!seenUsers.has(login)) {
        seenUsers.add(login);
        users.push({
          login,
          name: body.name ?? undefined,
          email: body.email ?? undefined,
          bio: body.bio ?? undefined,
        });
      }
    }

    // Extract repo from /repos/:owner/:name
    if (rec.path.match(/^\/repos\/[^/]+\/[^/]+$/) && body.full_name) {
      const fullName = String(body.full_name);
      if (!seenRepos.has(fullName)) {
        seenRepos.add(fullName);
        const [owner, name] = fullName.split("/");
        repos.push({
          owner,
          name,
          description: body.description ?? undefined,
          language: body.language ?? undefined,
          private: body.private ?? false,
        });
      }
    }

    // Extract repos from array responses (e.g., /user/repos)
    if (Array.isArray(body)) {
      for (const item of body) {
        if (item && typeof item === "object" && "full_name" in item) {
          const fullName = String(item.full_name);
          if (!seenRepos.has(fullName)) {
            seenRepos.add(fullName);
            const [owner, name] = fullName.split("/");
            repos.push({
              owner,
              name,
              description: item.description ?? undefined,
              language: item.language ?? undefined,
              private: item.private ?? false,
            });
          }
        }
      }
    }
  }

  const config: Record<string, unknown> = {};
  if (users.length > 0) config.users = users;
  if (repos.length > 0) config.repos = repos;
  return config;
}

function extractStripeEntities(recordings: RecordedExchange[]): Record<string, unknown> {
  const customers: Array<Record<string, unknown>> = [];
  const products: Array<Record<string, unknown>> = [];
  const seenCustomers = new Set<string>();
  const seenProducts = new Set<string>();

  for (const rec of recordings) {
    if (rec.responseStatus >= 400) continue;

    let body: Record<string, unknown>;
    try {
      body = JSON.parse(rec.responseBody);
    } catch {
      continue;
    }

    if (String(body.object) === "customer" && body.email) {
      const email = String(body.email);
      if (!seenCustomers.has(email)) {
        seenCustomers.add(email);
        customers.push({ email, name: body.name ?? undefined });
      }
    }

    if (String(body.object) === "product" && body.name) {
      const name = String(body.name);
      if (!seenProducts.has(name)) {
        seenProducts.add(name);
        products.push({ name, description: body.description ?? undefined });
      }
    }

    // Handle list responses
    if (body.data && Array.isArray(body.data)) {
      for (const item of body.data as Array<Record<string, unknown>>) {
        if (String(item.object) === "customer" && item.email) {
          const email = String(item.email);
          if (!seenCustomers.has(email)) {
            seenCustomers.add(email);
            customers.push({ email, name: item.name ?? undefined });
          }
        }
        if (String(item.object) === "product" && item.name) {
          const name = String(item.name);
          if (!seenProducts.has(name)) {
            seenProducts.add(name);
            products.push({ name, description: item.description ?? undefined });
          }
        }
      }
    }
  }

  const config: Record<string, unknown> = {};
  if (customers.length > 0) config.customers = customers;
  if (products.length > 0) config.products = products;
  return config;
}

const EXTRACTORS: Record<string, (recordings: RecordedExchange[]) => Record<string, unknown>> = {
  github: extractGitHubEntities,
  stripe: extractStripeEntities,
};

export async function recordCommand(options: RecordOptions): Promise<void> {
  const { port, upstream, service, output } = options;
  const normalizedUpstream = upstream.replace(/\/+$/, "");
  const recordings: RecordedExchange[] = [];

  const app = new Hono();
  app.use("*", cors());

  app.all("*", async (c) => {
    const path = c.req.path;
    const method = c.req.method;

    const upstreamUrl = `${normalizedUpstream}${path}${new URL(c.req.url).search}`;

    const headers = new Headers(c.req.raw.headers);
    headers.delete("host");

    let requestBody: string | null = null;
    if (method !== "GET" && method !== "HEAD") {
      requestBody = await c.req.text();
    }

    let upstreamRes: Response;
    try {
      upstreamRes = await fetch(upstreamUrl, {
        method,
        headers,
        body: requestBody,
        signal: AbortSignal.timeout(30000),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.text(`Upstream request failed: ${message}`, 502);
    }

    const responseBody = await upstreamRes.text();

    recordings.push({
      method,
      path,
      requestBody,
      responseStatus: upstreamRes.status,
      responseBody,
    });

    const resHeaders = new Headers(upstreamRes.headers);
    resHeaders.delete("content-encoding");
    resHeaders.delete("transfer-encoding");

    return new Response(responseBody, {
      status: upstreamRes.status,
      headers: resHeaders,
    });
  });

  const httpServer = serve({ fetch: app.fetch, port });

  const lines: string[] = [];
  lines.push("");
  lines.push(`  ${pc.bold("emulate record")} ${pc.dim(`-> ${upstream}`)}`);
  lines.push("");
  lines.push(`  ${pc.cyan(service.padEnd(12))}${pc.bold(`http://localhost:${port}`)}`);
  lines.push(`  ${pc.dim("upstream")}     ${upstream}`);
  lines.push("");
  lines.push(`  ${pc.dim("Press Ctrl+C to stop recording and generate config")}`);
  lines.push("");
  console.log(lines.join("\n"));

  const shutdown = () => {
    console.log(`\n${pc.dim(`Recorded ${recordings.length} exchanges`)}`);

    const extract = EXTRACTORS[service];
    const config: Record<string, unknown> = {};

    if (extract) {
      const entities = extract(recordings);
      if (Object.keys(entities).length > 0) {
        config[service] = entities;
      }
    }

    if (Object.keys(config).length > 0) {
      const yaml = yamlStringify(config);
      writeFileSync(output, yaml, "utf-8");
      console.log(`${pc.green("Config written to")} ${output}`);
    } else {
      console.log(pc.yellow("No entities extracted from recorded traffic"));
    }

    httpServer.close();
    process.exit(0);
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
