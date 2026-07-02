import { pageMetadata } from "@/lib/page-metadata";

export const metadata = pageMetadata("nuxt");

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
