import { pageMetadata } from "@/lib/page-metadata";

export const metadata = pageMetadata("okta");

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
