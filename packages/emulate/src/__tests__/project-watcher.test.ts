import { mkdtemp, mkdir, writeFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, expect } from "vitest";
import { ProjectWatcher } from "../project-watcher.js";

it("watches imports, atomic saves, missing files and fixture additions, and closes cleanly", async () => {
  const dir = await mkdtemp(join(tmpdir(), "emulate watch space "));
  const changes: string[] = [];
  const errors: unknown[] = [];
  const watcher = new ProjectWatcher(
    dir,
    (file) => changes.push(file),
    (error) => errors.push(error),
    20,
  );
  try {
    const entry = join(dir, "entry.ts");
    const missing = join(dir, "missing.ts");
    const fixture = join(dir, "fixtures/stock.json");
    await writeFile(entry, "export default 1");
    await watcher.start();
    await watcher.update([entry, missing], [join(dir, "fixtures/**")], false);
    await writeFile(join(dir, "temporary"), "export default 2");
    await rename(join(dir, "temporary"), entry);
    await expect.poll(() => changes).toContain(entry);
    changes.length = 0;
    await writeFile(entry, "");
    await new Promise((done) => setTimeout(done, 60));
    expect(changes).toEqual([]);
    await writeFile(entry, "export default 20");
    await expect.poll(() => changes).toEqual([entry]);
    await new Promise((done) => setTimeout(done, 120));
    expect(changes).toEqual([entry]);
    await mkdir(join(dir, "fixtures"));
    await writeFile(fixture, "{}");
    await writeFile(missing, "export default 3");
    await expect.poll(() => changes).toContain(fixture);
    await expect.poll(() => changes).toContain(missing);
    changes.length = 0;
    await rm(entry);
    await expect.poll(() => changes).toContain(entry);
    await watcher.update([missing], [], true);
    const recovered = join(dir, "new-import.ts");
    await writeFile(recovered, "export default 4");
    await expect.poll(() => changes).toContain(recovered);
    await watcher.close();
    changes.length = 0;
    await writeFile(missing, "export default 5");
    await new Promise((done) => setTimeout(done, 60));
    expect(changes).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await watcher.close();
    await rm(dir, { recursive: true, force: true });
  }
});
