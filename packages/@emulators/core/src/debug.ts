const isDebug = typeof process !== "undefined" && (process.env.DEBUG === "1" || process.env.DEBUG === "true" || process.env.EMULATE_DEBUG === "1");

export function debug(label: string, ...args: unknown[]): void {
  if (isDebug) {
    console.log(`[${label}]`, ...args);
  }
}
