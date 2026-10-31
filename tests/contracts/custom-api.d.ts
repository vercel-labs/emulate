export function customApiContract(options: {
  describe: any;
  it: any;
  expect: any;
  defineEmulator: any;
  create(config: any): { request(path: string, init?: RequestInit): Promise<Response>; close(): Promise<void> };
}): void;
