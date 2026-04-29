"use client";

import { useCart } from "@/lib/use-cart";

export function CartButton() {
  const { totalItems } = useCart();

  return (
    <a
      href="/cart"
      className="relative inline-flex items-center gap-2 text-[10px] tracking-[0.2em] uppercase text-muted-foreground transition-colors hover:text-foreground"
    >
      Bag
      {totalItems > 0 && <span className="font-mono text-[10px] tabular-nums">({totalItems})</span>}
    </a>
  );
}
