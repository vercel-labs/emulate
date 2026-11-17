interface PatternContext {
  pattern: string;
  value: string;
}

/**
 * Browser stand-in for the one way the emulators use `node:vm`: testing a string against a client pattern held in the
 * context. It runs no dynamic code and sets no time limit, so the caller's own budget is the only bound.
 */
export function createContext<T extends object>(sandbox: T): T {
  return sandbox;
}

export class Script {
  constructor(code: string) {
    if (!code.includes("regex.test(value)")) {
      throw new Error("vm.Script is not available in the browser playground");
    }
  }

  runInContext(context: PatternContext): boolean | null {
    let regex: RegExp;
    try {
      regex = new RegExp(context.pattern, "u");
    } catch {
      try {
        regex = new RegExp(context.pattern);
      } catch {
        return null;
      }
    }
    return regex.test(context.value);
  }
}
