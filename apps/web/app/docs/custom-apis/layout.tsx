import { pageMetadata } from "@/lib/page-metadata";

export const metadata = pageMetadata("custom-apis");

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
