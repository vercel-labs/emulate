import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { PlaygroundNav, type NavGroup } from "@/components/playground-nav";
import { flows } from "@/lib/playgrounds";
import { consoleServices } from "@/lib/services";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const navGroups: NavGroup[] = [
  { title: "Flows", links: flows.map(({ href, label }) => ({ href, label })) },
  { title: "API consoles", links: consoleServices.map(({ name, label }) => ({ href: `/services/${name}`, label })) },
];

const themeScript = `(function(){try{var t=localStorage.getItem("theme");if(t==="dark"||(!t&&matchMedia("(prefers-color-scheme: dark)").matches))document.documentElement.classList.add("dark")}catch(e){}})()`;

export const metadata: Metadata = {
  title: "emulate playground",
  description: "Every emulator embedded in one Next.js app, with a demo flow or request console for each",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col bg-background text-foreground md:flex-row">
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        <PlaygroundNav groups={navGroups} />
        <main className="flex min-w-0 flex-1 flex-col">{children}</main>
      </body>
    </html>
  );
}
