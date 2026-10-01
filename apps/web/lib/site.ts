export const siteName = "emulate";
export const siteUrl = "https://emulate.dev";
export const siteDescription =
  "Local drop-in replacement services for CI and no-network sandboxes. Fully stateful, production-fidelity API emulation.";
export const isPreview = Boolean(process.env.VERCEL_ENV && process.env.VERCEL_ENV !== "production");

export function canonicalUrlFor(pathname: string): string {
  return pathname === "/" ? siteUrl : `${siteUrl}${pathname}`;
}
