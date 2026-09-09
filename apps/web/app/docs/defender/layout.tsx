import { pageMetadata } from "@/lib/page-metadata";

export const metadata = pageMetadata("defender");

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
