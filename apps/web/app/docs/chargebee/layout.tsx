import { pageMetadata } from "@/lib/page-metadata";

export const metadata = pageMetadata("chargebee");

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
