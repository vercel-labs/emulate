import { pageMetadata } from "@/lib/page-metadata";

export const metadata = pageMetadata("auth0");

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
