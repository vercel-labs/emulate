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
  const result = spawnSync("portless", ["list"], { stdio: "ignore" });
  return result.status === 0;
}

function failPortless(message: string, throwOnFailure: boolean): never {
  if (throwOnFailure) {
    throw new Error(message);
  }
  console.error(message);
  process.exit(1);
}

export async function ensurePortless(options: { throwOnFailure?: boolean } = {}): Promise<void> {
  const throwOnFailure = options.throwOnFailure ?? false;
  if (!hasPortless()) {
    if (!isInteractive()) {
      failPortless("portless is required but not installed. Run: npm i -g portless", throwOnFailure);
    }

    const yes = await promptYesNo("portless is not installed. Install it now? (npm i -g portless) [Y/n] ");
    if (!yes) {
      failPortless("Cannot continue without portless.", throwOnFailure);
    }

    try {
      execSync("npm i -g portless", { stdio: "inherit" });
    } catch {
      failPortless("Failed to install portless.", throwOnFailure);
    }

    if (!hasPortless()) {
      failPortless("portless was installed but could not be found on PATH.", throwOnFailure);
    }
  }

  if (!isProxyRunning()) {
    failPortless("portless proxy is not running. Start it with: portless proxy start", throwOnFailure);
  }
}

export interface PortlessAlias {
  name: string;
  port: number;
}

export function registerAlias({ name, port }: PortlessAlias): void {
  const result = spawnSync("portless", ["alias", name, String(port), "--force"], {
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`Failed to register portless alias: ${name} -> ${port}`);
  }
}

export function registerAliases(aliases: PortlessAlias[]): void {
  const registered: PortlessAlias[] = [];
  for (const alias of aliases) {
    try {
      registerAlias(alias);
    } catch (error) {
      if (registered.length > 0) {
        removeAliases(registered);
      }
      throw error;
    }
    registered.push(alias);
  }
}

export function removeAlias({ name }: PortlessAlias): void {
  const result = spawnSync("portless", ["alias", "--remove", name], { stdio: "ignore" });
  if (result.status !== 0) {
    throw new Error(`failed to remove portless alias: ${name}`);
  }
}

export function removeAliases(aliases: PortlessAlias[]): void {
  for (const alias of aliases) {
    try {
      removeAlias(alias);
    } catch (error) {
      console.error(`Warning: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

export function portlessBaseUrl(serviceName: string): string {
  return `https://${serviceName}.emulate.localhost`;
}
