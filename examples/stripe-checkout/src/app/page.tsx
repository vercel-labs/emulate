export const dynamic = "force-dynamic";

import { stripe } from "@/lib/stripe";
import { Card, CardContent, CardFooter, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { AddToCart } from "@/components/add-to-cart";

function formatCurrency(amount: number, currency: string) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount / 100);
}

export default async function CatalogPage() {
  const [products, prices] = await Promise.all([
    stripe.products.list({ active: true }),
    stripe.prices.list({ active: true }),
  ]);

  const pricesByProduct = new Map<string, (typeof prices.data)[number]>();
  for (const price of prices.data) {
    if (typeof price.product === "string") {
      pricesByProduct.set(price.product, price);
    }
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-10">
      <div className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight">Products</h1>
        <p className="mt-2 text-muted-foreground">Browse items from the emulated Stripe catalog</p>
      </div>

      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
        {products.data.map((product) => {
          const price = pricesByProduct.get(product.id);
          return (
            <Card key={product.id} className="flex flex-col justify-between">
              <div>
                <CardHeader>
                  <CardTitle>{product.name}</CardTitle>
                  {product.description && <CardDescription>{product.description}</CardDescription>}
                </CardHeader>
                <CardContent>
                  {price ? (
                    <span className="text-2xl font-bold">
                      {formatCurrency(price.unit_amount ?? 0, price.currency)}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">No price</span>
                  )}
                </CardContent>
              </div>
              {price && (
                <CardFooter>
                  <AddToCart
                    priceId={price.id}
                    productName={product.name}
                    unitAmount={price.unit_amount ?? 0}
                    currency={price.currency}
                  />
                </CardFooter>
              )}
            </Card>
          );
        })}
      </div>
    </div>
  );
}
