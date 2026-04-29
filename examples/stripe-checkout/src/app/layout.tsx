import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { CartButton } from "@/components/cart-button";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Stripe Checkout with emulate",
  description: "A storefront demonstrating Stripe Checkout against the emulated Stripe API",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col bg-background text-foreground">
        <header className="border-b">
          <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-4">
            <a href="/" className="text-base font-semibold tracking-tight">
              Emulate Store
            </a>
            <CartButton />
          </div>
        </header>
        <main className="flex-1">{children}</main>
      </body>
    </html>
  );
}
