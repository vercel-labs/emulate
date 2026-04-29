"use client";

import Image from "next/image";
import { Minus, Plus } from "lucide-react";
import { useCart } from "@/lib/use-cart";
import { productImages, formatCurrency } from "@/lib/products";
import { createCheckoutSession } from "../actions";

export default function CartPage() {
  const { items, totalAmount, updateQuantity, removeItem } = useCart();

  if (items.length === 0) {
    return (
      <div className="mx-auto max-w-[1200px] px-6 py-32 text-center">
        <h1 className="font-pixel text-2xl">Your Bag</h1>
        <p className="mt-4 text-sm text-muted-foreground">Your bag is empty</p>
        <a
          href="/"
          className="mt-8 inline-flex h-10 items-center border border-foreground px-8 text-[10px] tracking-[0.2em] uppercase font-medium transition-colors hover:bg-foreground hover:text-background"
        >
          Continue Shopping
        </a>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[640px] px-6 py-20">
      <div className="text-center mb-12">
        <h1 className="font-pixel text-2xl">Your Bag</h1>
        <p className="mt-3 text-[10px] tracking-[0.3em] uppercase text-muted-foreground">
          {items.length} {items.length === 1 ? "item" : "items"}
        </p>
      </div>

      <div className="divide-y divide-border">
        {items.map((item) => {
          const imageSrc = productImages[item.productName];
          return (
            <div key={item.priceId} className="flex items-start gap-5 py-6">
              {imageSrc && (
                <div className="relative aspect-square w-20 shrink-0 overflow-hidden bg-secondary border border-border">
                  <Image
                    src={imageSrc}
                    alt={item.productName}
                    fill
                    className="object-cover"
                    sizes="80px"
                  />
                </div>
              )}

              <div className="min-w-0 flex-1 pt-0.5">
                <p className="text-xs tracking-wide uppercase font-medium">{item.productName}</p>
                <p className="mt-1 text-xs text-muted-foreground font-mono tabular-nums">
                  {formatCurrency(item.unitAmount, item.currency)}
                </p>

                <div className="mt-4 flex items-center gap-4">
                  <div className="flex items-center border border-border">
                    <button
                      type="button"
                      onClick={() => updateQuantity(item.priceId, -1)}
                      className="flex size-7 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
                    >
                      <Minus className="size-3" />
                    </button>
                    <span className="flex size-7 items-center justify-center font-mono text-xs tabular-nums">
                      {item.quantity}
                    </span>
                    <button
                      type="button"
                      onClick={() => updateQuantity(item.priceId, 1)}
                      className="flex size-7 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
                    >
                      <Plus className="size-3" />
                    </button>
                  </div>

                  <button
                    type="button"
                    onClick={() => removeItem(item.priceId)}
                    className="text-[10px] tracking-[0.15em] uppercase text-muted-foreground underline underline-offset-4 transition-colors hover:text-foreground"
                  >
                    Remove
                  </button>
                </div>
              </div>

              <span className="pt-0.5 font-mono text-xs tabular-nums">
                {formatCurrency(item.unitAmount * item.quantity, item.currency)}
              </span>
            </div>
          );
        })}
      </div>

      <div className="mt-8 border-t border-border pt-6">
        <div className="flex items-center justify-between">
          <span className="text-[10px] tracking-[0.3em] uppercase">Subtotal</span>
          <span className="font-mono text-sm tabular-nums">
            {formatCurrency(totalAmount, items[0]?.currency ?? "usd")}
          </span>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">Shipping and taxes calculated at checkout</p>
      </div>

      <form action={createCheckoutSession} className="mt-8">
        <button
          type="submit"
          className="flex h-12 w-full items-center justify-center bg-foreground text-[10px] tracking-[0.2em] uppercase font-medium text-background transition-opacity hover:opacity-80"
        >
          Proceed to Checkout
        </button>
      </form>

      <div className="mt-4 text-center">
        <a
          href="/"
          className="text-[10px] tracking-[0.15em] uppercase text-muted-foreground underline underline-offset-4 transition-colors hover:text-foreground"
        >
          Continue Shopping
        </a>
      </div>
    </div>
  );
}
