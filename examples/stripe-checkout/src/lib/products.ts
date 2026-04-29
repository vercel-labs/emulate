export const productImages: Record<string, string> = {
  "Emulate T-Shirt": "/products/tshirt.webp",
  "Emulate Mug": "/products/mug.webp",
  "Emulate Sticker Pack": "/products/stickers.webp",
  "Emulate Hoodie": "/products/hoodie.webp",
};

export function formatCurrency(amount: number, currency: string) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount / 100);
}
