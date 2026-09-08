import { pageMetadata } from "@/lib/page-metadata";

export const metadata = pageMetadata("facebook");

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
