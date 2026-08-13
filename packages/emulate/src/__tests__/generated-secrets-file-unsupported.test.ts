import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  link: vi.fn(async () => {
    const error = new Error("hard links unavailable") as NodeJS.ErrnoException;
    error.code = "EOPNOTSUPP";
    throw error;
  }),
}));

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  link: mocks.link,
}));

const { preflightGeneratedSecretsFile } = await import("../generated-secrets-file.js");
const directories: string[] = [];

afterEach(async () => {
  vi.clearAllMocks();
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("generated secrets filesystem support", () => {
  it("fails closed and removes probes when hard links are unsupported", async () => {
    const directory = await mkdtemp(join(tmpdir(), "emulate-generated-secrets-unsupported-"));
    directories.push(directory);

    await expect(preflightGeneratedSecretsFile(join(directory, "secrets.json"))).rejects.toMatchObject({
      code: "EOPNOTSUPP",
    });

    expect(mocks.link).toHaveBeenCalledOnce();
    expect(await readdir(directory)).toEqual([]);
  });
});
