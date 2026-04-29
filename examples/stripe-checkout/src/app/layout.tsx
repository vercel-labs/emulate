import type { Metadata } from "next";
import { GeistMono } from "geist/font/mono";
import { GeistPixelSquare } from "geist/font/pixel";
import { getCart } from "@/lib/cart";
import { CartProvider } from "@/lib/use-cart";
import { CartButton } from "@/components/cart-button";
import "./globals.css";

export const metadata: Metadata = {
  title: "Stripe Checkout with emulate",
  description: "A storefront demonstrating Stripe Checkout against the emulated Stripe API",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const initialItems = await getCart();

  return (
    <html lang="en" className={`${GeistMono.variable} ${GeistPixelSquare.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col bg-background text-foreground font-mono">
        <CartProvider initialItems={initialItems}>
          <header className="sticky top-0 z-50 border-b border-border/50 bg-background/90 backdrop-blur-xl">
            <div className="mx-auto flex h-16 max-w-[1200px] items-center justify-between px-6">
              <a href="/" className="font-pixel text-xl tracking-wide">
                emu store
              </a>
              <CartButton />
            </div>
          </header>
          <main className="flex-1">{children}</main>
          <footer className="border-t border-border/50 py-10">
            <div className="mx-auto max-w-[1200px] px-6 text-center text-xs tracking-widest uppercase text-muted-foreground">
              Powered by the emulated Stripe API
            </div>
          </footer>
        </CartProvider>
      </body>
    </html>
  );
}
