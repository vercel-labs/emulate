import { getCart } from "@/lib/cart";
import { AddToCartClient } from "./add-to-cart-client";

interface AddToCartProps {
  priceId: string;
  productName: string;
  unitAmount: number;
  currency: string;
  full?: boolean;
}

export async function AddToCart({ priceId, productName, unitAmount, currency, full }: AddToCartProps) {
  const items = await getCart();
  const quantity = items.find((i) => i.priceId === priceId)?.quantity ?? 0;

  return (
    <AddToCartClient
      priceId={priceId}
      productName={productName}
      unitAmount={unitAmount}
      currency={currency}
      quantity={quantity}
      full={full}
    />
  );
}
