import { pageMetadata } from "@/lib/page-metadata";

export const metadata = pageMetadata("aps");

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
