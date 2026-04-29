import { ShoppingCart } from "lucide-react";
import { getCart, cartTotals } from "@/lib/cart";
import { cn } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/button-variants";

export async function CartButton() {
  const items = await getCart();
  const { totalItems } = cartTotals(items);

  return (
    <a href="/cart" className={cn(buttonVariants({ variant: "outline", size: "default" }), "relative gap-2")}>
      <ShoppingCart className="size-4" />
      <span>Cart</span>
      {totalItems > 0 && (
        <span className="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full bg-primary text-[0.65rem] font-bold text-primary-foreground">
          {totalItems}
        </span>
      )}
    </a>
  );
}
