export const dynamic = "force-dynamic";

import Image from "next/image";
import Link from "next/link";
import { stripe } from "@/lib/stripe";
import { productImages, formatCurrency } from "@/lib/products";
import { AddToCartClient } from "@/components/add-to-cart-client";

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
    <div className="mx-auto max-w-[1200px] px-6 py-20">
      <div className="mb-16 text-center">
        <p className="text-[10px] tracking-[0.3em] uppercase text-muted-foreground mb-4">New Arrivals</p>
        <h1 className="font-pixel text-3xl md:text-4xl">The Collection</h1>
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-12 max-w-[800px] mx-auto">
        {products.data.map((product) => {
          const price = pricesByProduct.get(product.id);
          const imageSrc = productImages[product.name];

          return (
            <div key={product.id} className="group flex flex-col">
              <Link href={`/products/${product.id}`} className="block">
                <div className="relative aspect-square overflow-hidden bg-secondary border border-border">
                  {imageSrc && (
                    <Image
                      src={imageSrc}
                      alt={product.name}
                      fill
                      className="object-cover transition-all duration-700 ease-out group-hover:scale-[1.03]"
                      sizes="(min-width: 768px) 400px, 50vw"
                    />
                  )}
                </div>
              </Link>
              <div className="pt-4">
                <Link href={`/products/${product.id}`}>
                  <p className="text-xs tracking-wide uppercase">{product.name}</p>
                </Link>
                <p className="mt-1.5 font-mono text-xs tabular-nums text-muted-foreground">
                  {price ? formatCurrency(price.unit_amount ?? 0, price.currency) : "N/A"}
                </p>
                <div className="mt-3">
                  {price && (
                    <AddToCartClient
                      priceId={price.id}
                      productName={product.name}
                      unitAmount={price.unit_amount ?? 0}
                      currency={price.currency}
                    />
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
