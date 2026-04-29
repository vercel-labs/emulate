import { pageMetadata } from "@/lib/page-metadata";

export const metadata = pageMetadata("discord");

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
