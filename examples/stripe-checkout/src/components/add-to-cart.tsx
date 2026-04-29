"use client";

import { useActionState } from "react";
import { Plus, Check } from "lucide-react";
import { addToCartAction } from "@/app/actions";
import { Button } from "@/components/ui/button";

interface AddToCartProps {
  priceId: string;
  productName: string;
  unitAmount: number;
  currency: string;
}

export function AddToCart({ priceId, productName, unitAmount, currency }: AddToCartProps) {
  const [added, dispatch, pending] = useActionState(async (_prev: boolean) => {
    const fd = new FormData();
    fd.set("priceId", priceId);
    fd.set("productName", productName);
    fd.set("unitAmount", String(unitAmount));
    fd.set("currency", currency);
    await addToCartAction(fd);
    return true;
  }, false);

  return (
    <form action={dispatch}>
      <Button type="submit" size="lg" variant={added ? "secondary" : "default"} className="w-full" disabled={pending}>
        {added ? (
          <>
            <Check className="size-4" />
            Added
          </>
        ) : (
          <>
            <Plus className="size-4" />
            Add to cart
          </>
        )}
      </Button>
    </form>
  );
}
