/** Browser stand-in for the part of `node:vm` the emulators use: running an expression against named values. It sets no time limit, so the caller's own budget is the only bound. */
export function createContext<T extends object>(sandbox: T): T {
  return sandbox;
}

export class Script {
  constructor(private readonly code: string) {}

  runInContext(context: Record<string, unknown>): unknown {
    return new Function(...Object.keys(context), `return ${this.code};`)(...Object.values(context));
  }
}
