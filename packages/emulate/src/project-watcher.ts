import { readdir, stat } from "node:fs/promises";
import { dirname, join, matchesGlob, resolve, sep } from "node:path";

const ignored = /(?:^|[/\\])(?:node_modules|\.git|\.emulate|dist|\.next|\.turbo)(?:[/\\]|$)/;
const source = /\.(?:[cm]?[jt]s|json|ya?ml)$/;
const missing = (error: unknown) => ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "");
const matches = (path: string, pattern: string) => matchesGlob(path, pattern) || path.startsWith(pattern + sep);

/** Poll only imported files and fixture trees during normal operation; scan source trees during recovery. */
export class ProjectWatcher {
  private files = new Set<string>();
  private patterns: string[] = [];
  private previous = new Map<string, string>();
  private readonly changes = new Map<string, { stamp: string | undefined; since: number }>();
  private recovery = true;
  private stopped = false;
  private timer?: ReturnType<typeof setTimeout>;
  private pending: Promise<void> = Promise.resolve();

  constructor(
    private readonly directory: string,
    private readonly change: (path: string) => void,
    private readonly error: (error: unknown) => void,
    private readonly interval = 150,
  ) {}

  private async snapshot(): Promise<Map<string, string>> {
    const files = new Set(this.files);
    const roots = new Set(
      this.patterns.map((pattern) => {
        const prefix = pattern.split(/[*?{[]/)[0];
        return prefix.endsWith(sep) ? prefix : dirname(prefix);
      }),
    );
    if (this.recovery) roots.add(this.directory);
    const visited = new Set<string>();
    const walk = async (directory: string): Promise<void> => {
      if (this.stopped || visited.has(directory) || ignored.test(directory)) return;
      visited.add(directory);
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        if (missing(error)) return;
        throw error;
      }
      for (const entry of entries) {
        const path = join(directory, entry.name);
        if (ignored.test(path)) continue;
        if (entry.isDirectory()) await walk(path);
        else if ((this.recovery && source.test(path)) || this.patterns.some((pattern) => matches(path, pattern)))
          files.add(path);
      }
    };
    for (const root of roots) await walk(resolve(root));
    const result = new Map<string, string>();
    // Bounded concurrency avoids exhausting file handles in projects with many fixtures.
    const paths = [...files];
    let cursor = 0;
    await Promise.all(
      Array.from({ length: Math.min(16, paths.length) }, async () => {
        while (!this.stopped && cursor < paths.length) {
          const path = paths[cursor++];
          try {
            const info = await stat(path, { bigint: true });
            result.set(path, `${info.mtimeNs}:${info.ctimeNs}:${info.size}:${info.ino}`);
          } catch (error) {
            if (!missing(error)) throw error;
          }
        }
      }),
    );
    return result;
  }

  private async scan(baseline = false): Promise<void> {
    const current = await this.snapshot();
    if (!baseline && !this.stopped) {
      for (const path of new Set([...this.previous.keys(), ...current.keys()])) {
        if (this.previous.get(path) !== current.get(path))
          this.changes.set(path, { stamp: current.get(path), since: Date.now() });
      }
      // Editors may truncate and rewrite in separate operations. Emit once the observed version has settled.
      for (const [path, change] of this.changes) {
        if (current.get(path) === change.stamp && Date.now() - change.since >= 100) {
          this.changes.delete(path);
          this.change(path);
        }
      }
    }
    this.previous = current;
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.pending = this.pending
        .then(() => this.scan())
        .catch(this.error)
        .finally(() => this.schedule());
    }, this.interval);
  }

  async start(): Promise<void> {
    await this.scan(true).catch(this.error);
    this.schedule();
  }

  async update(files: Iterable<string>, patterns: string[], recovery: boolean): Promise<void> {
    // Serialize configuration changes with scans, so removed watch roots cannot generate spurious reloads.
    this.pending = this.pending
      .then(async () => {
        if (this.stopped) return;
        this.files = new Set(files);
        this.patterns = patterns;
        this.recovery = recovery;
        const current = await this.snapshot();
        // Catch edits made while a candidate was loading, without treating newly watched files as edits.
        for (const [path, stamp] of this.previous) {
          const retained = this.files.has(path) || current.has(path);
          if (!retained) this.changes.delete(path);
          else if (!this.stopped && current.get(path) !== stamp)
            this.changes.set(path, { stamp: current.get(path), since: Date.now() });
        }
        this.previous = current;
      })
      .catch(this.error);
    await this.pending;
  }

  async close(): Promise<void> {
    this.stopped = true;
    this.changes.clear();
    clearTimeout(this.timer);
    await this.pending;
  }
}
