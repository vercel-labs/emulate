import { cookies } from "next/headers";
import { DocsMobileNav } from "@/components/docs-mobile-nav";
import { DocsNav } from "@/components/docs-nav";
import { DocsChat } from "@/components/docs-chat";

export default async function DocsLayout({ children }: { children: React.ReactNode }) {
  const cookieStore = await cookies();
  const chatOpen = cookieStore.get("docs-chat-open")?.value === "true";
  const chatWidth = Number(cookieStore.get("docs-chat-width")?.value) || 400;

  return (
    <>
      {chatOpen && (
        <style
          dangerouslySetInnerHTML={{
            __html: `@media(min-width:640px){body{padding-right:${chatWidth}px}}`,
          }}
        />
      )}
      <DocsMobileNav />
      <DocsNav>{children}</DocsNav>
      <DocsChat defaultOpen={chatOpen} defaultWidth={chatWidth} />
    </>
  );
}
