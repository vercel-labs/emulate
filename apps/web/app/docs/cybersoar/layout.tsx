import { pageMetadata } from "@/lib/page-metadata";

export const metadata = pageMetadata("cybersoar");

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
