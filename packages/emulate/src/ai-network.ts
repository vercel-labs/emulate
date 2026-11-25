/** Whether a host name or bound address stays on this machine. */
export function isLoopbackHost(host: string): boolean {
  const normalized = host.replace(/^\[|\]$/g, "").toLowerCase();
  return normalized === "localhost" || normalized === "::1" || normalized.startsWith("127.");
}

/** The startup warning for an AI service reachable beyond loopback. */
export function aiNetworkWarning(host: string): string {
  return `AI control routes are reachable on ${host} without authentication. Use a trusted network.`;
}
