import { Minus, Plus, Trash2, ShoppingBag } from "lucide-react";
import { getCart, cartTotals } from "@/lib/cart";
import { updateQuantityAction, removeFromCartAction, createCheckoutSession } from "../actions";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { buttonVariants } from "@/components/ui/button-variants";
import { cn } from "@/lib/utils";

function formatCurrency(amount: number, currency: string) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount / 100);
}

export default async function CartPage() {
  const items = await getCart();
  const { totalAmount } = cartTotals(items);

  if (items.length === 0) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-16 text-center">
        <ShoppingBag className="mx-auto mb-4 size-12 text-muted-foreground" />
        <h1 className="text-2xl font-bold">Your cart is empty</h1>
        <p className="mt-2 text-muted-foreground">Add some items from the catalog to get started.</p>
        <a href="/" className={cn(buttonVariants({ variant: "outline", size: "lg" }), "mt-6")}>
          Browse products
        </a>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-10">
      <h1 className="mb-6 text-3xl font-bold tracking-tight">Cart</h1>

      <Card>
        <CardHeader>
          <CardTitle>
            {items.length} {items.length === 1 ? "item" : "items"}
          </CardTitle>
        </CardHeader>

        <CardContent className="divide-y">
          {items.map((item) => (
            <div key={item.priceId} className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0">
              <div className="min-w-0 flex-1">
                <p className="font-medium truncate">{item.productName}</p>
                <p className="text-sm text-muted-foreground">
                  {formatCurrency(item.unitAmount, item.currency)} each
                </p>
              </div>

              <div className="flex items-center gap-2">
                <form action={updateQuantityAction}>
                  <input type="hidden" name="priceId" value={item.priceId} />
                  <input type="hidden" name="delta" value="-1" />
                  <button
                    type="submit"
                    disabled={item.quantity <= 1}
                    className={cn(buttonVariants({ variant: "outline", size: "icon" }), "size-7")}
                  >
                    <Minus className="size-3" />
                  </button>
                </form>
                <span className="w-8 text-center text-sm font-medium tabular-nums">{item.quantity}</span>
                <form action={updateQuantityAction}>
                  <input type="hidden" name="priceId" value={item.priceId} />
                  <input type="hidden" name="delta" value="1" />
                  <button type="submit" className={cn(buttonVariants({ variant: "outline", size: "icon" }), "size-7")}>
                    <Plus className="size-3" />
                  </button>
                </form>
              </div>

              <div className="flex items-center gap-3">
                <span className="w-20 text-right font-medium tabular-nums">
                  {formatCurrency(item.unitAmount * item.quantity, item.currency)}
                </span>
                <form action={removeFromCartAction}>
                  <input type="hidden" name="priceId" value={item.priceId} />
                  <button type="submit" className={cn(buttonVariants({ variant: "ghost", size: "icon" }), "size-7")}>
                    <Trash2 className="size-3.5 text-muted-foreground" />
                  </button>
                </form>
              </div>
            </div>
          ))}
        </CardContent>

        <CardFooter className="flex-col gap-4">
          <div className="flex w-full items-center justify-between">
            <span className="text-base font-medium">Total</span>
            <span className="text-xl font-bold tabular-nums">{formatCurrency(totalAmount, "usd")}</span>
          </div>
          <form action={createCheckoutSession} className="w-full">
            <button type="submit" className={cn(buttonVariants({ size: "lg" }), "w-full")}>
              Checkout
            </button>
          </form>
        </CardFooter>
      </Card>
    </div>
  );
}
