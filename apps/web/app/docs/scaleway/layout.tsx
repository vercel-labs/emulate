import { pageMetadata } from "@/lib/page-metadata";

export const metadata = pageMetadata("scaleway");

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
