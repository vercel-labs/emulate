export const dynamic = "force-dynamic";

import { notFound } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import { stripe } from "@/lib/stripe";
import { productImages, formatCurrency } from "@/lib/products";
import { AddToCart } from "@/components/add-to-cart";

export default async function ProductPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let product;
  try {
    product = await stripe.products.retrieve(id);
  } catch {
    notFound();
  }

  const prices = await stripe.prices.list({ active: true });
  const price = prices.data.find(
    (p) => (typeof p.product === "string" ? p.product : p.product?.id) === product.id,
  );

  const imageSrc = productImages[product.name];

  return (
    <div className="mx-auto max-w-[1200px] px-6 py-20">
      <Link
        href="/"
        className="inline-flex items-center gap-2 text-[10px] tracking-[0.3em] uppercase text-muted-foreground transition-colors hover:text-foreground"
      >
        <span aria-hidden="true">&larr;</span>
        Back to shop
      </Link>

      <div className="mt-10 grid grid-cols-1 gap-10 md:grid-cols-2 md:gap-16">
        <div className="relative aspect-square overflow-hidden bg-secondary border border-border">
          {imageSrc && (
            <Image
              src={imageSrc}
              alt={product.name}
              fill
              className="object-cover"
              sizes="(min-width: 768px) 50vw, 100vw"
              priority
            />
          )}
        </div>

        <div className="flex flex-col justify-center">
          <p className="text-[10px] tracking-[0.3em] uppercase text-muted-foreground">Product</p>
          <h1 className="mt-3 font-pixel text-2xl md:text-3xl">{product.name}</h1>
          <p className="mt-4 font-mono text-sm tabular-nums text-muted-foreground">
            {price ? formatCurrency(price.unit_amount ?? 0, price.currency) : "N/A"}
          </p>
          {product.description && (
            <p className="mt-6 text-sm text-muted-foreground leading-relaxed max-w-sm">{product.description}</p>
          )}

          <div className="mt-10 max-w-xs">
            {price && (
              <AddToCart
                priceId={price.id}
                productName={product.name}
                unitAmount={price.unit_amount ?? 0}
                currency={price.currency}
                full
              />
            )}
          </div>

          <div className="mt-10 border-t border-border pt-6 max-w-xs">
            <p className="text-[10px] tracking-[0.3em] uppercase text-muted-foreground mb-3">Details</p>
            <ul className="space-y-2 text-xs text-muted-foreground leading-relaxed">
              <li>Emulated product for demonstration</li>
              <li>Checkout powered by Stripe API</li>
              <li>No real charges processed</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
