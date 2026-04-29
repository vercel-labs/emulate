import { pageMetadata } from "@/lib/page-metadata";

export const metadata = pageMetadata("microsoft");

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
