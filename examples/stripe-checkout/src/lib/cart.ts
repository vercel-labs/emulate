import { cookies } from "next/headers";

export interface CartItem {
  priceId: string;
  productName: string;
  unitAmount: number;
  currency: string;
  quantity: number;
}

const COOKIE_NAME = "cart";

export async function getCart(): Promise<CartItem[]> {
  const cookieStore = await cookies();
  const raw = cookieStore.get(COOKIE_NAME)?.value;
  if (!raw) return [];
  try {
    return JSON.parse(decodeURIComponent(raw));
  } catch {
    try {
      return JSON.parse(Buffer.from(raw, "base64url").toString("utf-8"));
    } catch {
      return [];
    }
  }
}

export async function clearCart(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(COOKIE_NAME);
}
