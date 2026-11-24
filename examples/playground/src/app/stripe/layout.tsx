import Link from "next/link";
import { GeistPixelSquare } from "geist/font/pixel";
import { getCart } from "@/lib/stripe/cart";
import { CartProvider } from "@/lib/stripe/use-cart";
import { CartButton } from "@/components/stripe/cart-button";

export default async function StripeLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const initialItems = await getCart();

  return (
    <div className={`stripe-store ${GeistPixelSquare.variable} flex flex-1 flex-col font-mono`}>
      <CartProvider initialItems={initialItems}>
        <header className="sticky top-0 z-50 border-b border-border/50 bg-background/90 backdrop-blur-xl">
          <div className="mx-auto flex h-16 max-w-[1200px] items-center justify-between px-6">
            <Link href="/stripe" className="font-pixel text-xl tracking-wide">
              emu store
            </Link>
            <CartButton />
          </div>
        </header>
        <div className="flex-1">{children}</div>
        <footer className="border-t border-border/50 py-10">
          <div className="mx-auto max-w-[1200px] px-6 text-center text-xs tracking-widest uppercase text-muted-foreground">
            Powered by the emulated Stripe API
          </div>
        </footer>
      </CartProvider>
    </div>
  );
}
