import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const cli = resolve(dirname(fileURLToPath(import.meta.url)), "../../dist/index.js");

async function availablePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

it("charges each GitHub request once in the built CLI", async () => {
  const directory = await mkdtemp(join(tmpdir(), "emulate-cli-"));
  const port = await availablePort();
  const child = spawn(process.execPath, [cli, "start", "--service", "github", "--port", String(port)], {
    cwd: directory,
    env: { ...process.env, CI: "1", EMULATE_BASE_URL: "", PORTLESS_URL: "" },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  child.stdout!.resume();
  child.stderr!.resume();
  const exited = once(child, "exit");
  try {
    await once(child, "message");
    const base = `http://127.0.0.1:${port}`;
    const headers = { Authorization: "token test_token_admin", "Content-Type": "application/json" };
    const used = async () => {
      const body = (await (await fetch(`${base}/rate_limit`, { headers })).json()) as {
        resources: Record<string, { used: number }>;
      };
      return { core: body.resources.core.used, graphql: body.resources.graphql.used };
    };

    await fetch(`${base}/user/repos`, { method: "POST", headers, body: JSON.stringify({ name: "limits" }) });
    const issue = (await (
      await fetch(`${base}/repos/admin/limits/issues`, {
        method: "POST",
        headers,
        body: JSON.stringify({ title: "Rate limit" }),
      })
    ).json()) as { node_id: string };

    const start = await used();
    expect((await fetch(`${base}/api/v3/user`, { headers })).status).toBe(200);
    expect(await used()).toEqual({ core: start.core + 1, graphql: start.graphql });

    const mutation = await fetch(`${base}/graphql`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        query: "mutation($id: ID!) { addComment(input: { subjectId: $id, body: \"hi\" }) { clientMutationId } }",
        variables: { id: issue.node_id },
      }),
    });
    expect(((await mutation.json()) as { errors?: unknown }).errors).toBeUndefined();
    expect(await used()).toEqual({ core: start.core + 1, graphql: start.graphql + 1 });
  } finally {
    child.kill("SIGKILL");
    await exited;
    await rm(directory, { recursive: true, force: true });
  }
}, 15000);
