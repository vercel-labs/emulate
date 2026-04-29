import { execSync, spawnSync } from "child_process";
import { createInterface } from "readline";

function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY) && !process.env.CI;
}

function hasPortless(): boolean {
  const result = spawnSync("portless", ["--version"], { stdio: "ignore" });
  return result.status === 0;
}

function promptYesNo(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      const normalized = answer.trim().toLowerCase();
      resolve(normalized === "" || normalized === "y" || normalized === "yes");
    });
  });
}

function isProxyRunning(): boolean {
  const result = spawnSync("portless", ["proxy", "status"], { stdio: "ignore" });
  return result.status === 0;
}

export async function ensurePortless(): Promise<void> {
  if (!hasPortless()) {
    if (!isInteractive()) {
      console.error("portless is required but not installed. Run: npm i -g portless");
      process.exit(1);
    }

    const yes = await promptYesNo("portless is not installed. Install it now? (npm i -g portless) [Y/n] ");
    if (!yes) {
      console.error("Cannot continue without portless.");
      process.exit(1);
    }

    try {
      execSync("npm i -g portless", { stdio: "inherit" });
    } catch {
      console.error("Failed to install portless.");
      process.exit(1);
    }

    if (!hasPortless()) {
      console.error("portless was installed but could not be found on PATH.");
      process.exit(1);
    }
  }

  if (!isProxyRunning()) {
    console.error("portless proxy is not running. Start it with: portless proxy start");
    process.exit(1);
  }
}

export interface PortlessAlias {
  name: string;
  port: number;
}

export function registerAliases(aliases: PortlessAlias[]): void {
  const registered: PortlessAlias[] = [];
  for (const { name, port } of aliases) {
    const result = spawnSync("portless", ["alias", name, String(port), "--force"], {
      stdio: "inherit",
    });
    if (result.status !== 0) {
      if (registered.length > 0) {
        removeAliases(registered);
      }
      throw new Error(`Failed to register portless alias: ${name} -> ${port}`);
    }
    registered.push({ name, port });
  }
}

export function removeAliases(aliases: PortlessAlias[]): void {
  for (const { name } of aliases) {
    spawnSync("portless", ["alias", "--remove", name], { stdio: "ignore" });
  }
}

export function portlessBaseUrl(serviceName: string): string {
  return `https://${serviceName}.emulate.localhost`;
}
