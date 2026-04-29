"use client";

import { Minus, Plus } from "lucide-react";
import { addToCartAction, updateQuantityAction } from "@/app/actions";

interface Props {
  priceId: string;
  productName: string;
  unitAmount: number;
  currency: string;
  quantity: number;
  full?: boolean;
}

const height = { full: "h-12", compact: "h-8" } as const;

export function AddToCartClient({ priceId, productName, unitAmount, currency, quantity, full }: Props) {
  const h = full ? height.full : height.compact;

  if (quantity > 0) {
    return (
      <div className={`flex w-full items-center border border-border ${h}`}>
        <form action={updateQuantityAction}>
          <input type="hidden" name="priceId" value={priceId} />
          <input type="hidden" name="delta" value="-1" />
          <button
            type="submit"
            className={`flex ${h} w-10 items-center justify-center text-muted-foreground transition-colors hover:text-foreground`}
          >
            <Minus className="size-3" />
          </button>
        </form>
        <span className={`flex ${h} flex-1 items-center justify-center font-mono text-xs tabular-nums`}>
          {quantity}
        </span>
        <form action={updateQuantityAction}>
          <input type="hidden" name="priceId" value={priceId} />
          <input type="hidden" name="delta" value="1" />
          <button
            type="submit"
            className={`flex ${h} w-10 items-center justify-center text-muted-foreground transition-colors hover:text-foreground`}
          >
            <Plus className="size-3" />
          </button>
        </form>
      </div>
    );
  }

  return (
    <form action={addToCartAction}>
      <input type="hidden" name="priceId" value={priceId} />
      <input type="hidden" name="productName" value={productName} />
      <input type="hidden" name="unitAmount" value={String(unitAmount)} />
      <input type="hidden" name="currency" value={currency} />
      <button
        type="submit"
        className={
          full
            ? `flex ${h} w-full items-center justify-center bg-foreground text-[10px] tracking-[0.2em] uppercase font-medium text-background transition-opacity hover:opacity-80`
            : `flex ${h} w-full items-center justify-center border border-foreground text-[10px] tracking-[0.15em] uppercase font-medium transition-colors hover:bg-foreground hover:text-background`
        }
      >
        Add to Bag
      </button>
    </form>
  );
}
