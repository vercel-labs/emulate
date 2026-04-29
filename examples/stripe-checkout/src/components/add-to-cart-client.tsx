"use client";

import { Minus, Plus } from "lucide-react";
import { useCart } from "@/lib/use-cart";

interface Props {
  priceId: string;
  productName: string;
  unitAmount: number;
  currency: string;
  full?: boolean;
}

export function AddToCartClient({ priceId, productName, unitAmount, currency, full }: Props) {
  const { items, addItem, updateQuantity } = useCart();
  const quantity = items.find((i) => i.priceId === priceId)?.quantity ?? 0;
  const h = full ? "h-12" : "h-8";

  if (quantity > 0) {
    return (
      <div className={`flex w-full items-center border border-border ${h}`}>
        <button
          type="button"
          onClick={() => updateQuantity(priceId, -1)}
          className={`flex ${h} w-10 items-center justify-center text-muted-foreground transition-colors hover:text-foreground`}
        >
          <Minus className="size-3" />
        </button>
        <span className={`flex ${h} flex-1 items-center justify-center font-mono text-xs tabular-nums`}>
          {quantity}
        </span>
        <button
          type="button"
          onClick={() => updateQuantity(priceId, 1)}
          className={`flex ${h} w-10 items-center justify-center text-muted-foreground transition-colors hover:text-foreground`}
        >
          <Plus className="size-3" />
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => addItem({ priceId, productName, unitAmount, currency })}
      className={
        full
          ? `flex ${h} w-full items-center justify-center bg-foreground text-[10px] tracking-[0.2em] uppercase font-medium text-background transition-opacity hover:opacity-80`
          : `flex ${h} w-full items-center justify-center border border-foreground text-[10px] tracking-[0.15em] uppercase font-medium transition-colors hover:bg-foreground hover:text-background`
      }
    >
      Add to Bag
    </button>
  );
}
