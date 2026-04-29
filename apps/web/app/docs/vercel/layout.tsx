import { pageMetadata } from "@/lib/page-metadata";

export const metadata = pageMetadata("vercel");

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
