export interface TestPersistence {
  load(): Promise<string | null>;
  save(data: string): Promise<void>;
  initialize(data: string): Promise<string>;
}
interface Handler {
  generatedSecrets(): Promise<readonly { value: string }[]>;
}
interface Harness<Config, AdapterHandler extends Handler> {
  createEmulateHandler(config: Config): AdapterHandler;
  config(persistence?: TestPersistence, privateKey?: string): Config;
  createExplicitPrivateKey(): Promise<string>;
  requestApp(handler: AdapterHandler, authorization?: string, method?: "GET" | "POST"): Promise<Response>;
  request(handler: AdapterHandler, path: string, authorization?: string, method?: "GET" | "POST"): Promise<Response>;
}
export function githubAppIdentityContract<Config, AdapterHandler extends Handler>(
  harness: Harness<Config, AdapterHandler>,
): void;
