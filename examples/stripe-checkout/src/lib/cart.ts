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
    return JSON.parse(Buffer.from(raw, "base64url").toString("utf-8"));
  } catch {
    return [];
  }
}

export async function setCart(items: CartItem[]): Promise<void> {
  const cookieStore = await cookies();
  if (items.length === 0) {
    cookieStore.delete(COOKIE_NAME);
    return;
  }
  cookieStore.set(COOKIE_NAME, Buffer.from(JSON.stringify(items)).toString("base64url"), {
    httpOnly: true,
    path: "/",
    maxAge: 86400,
  });
}

export function cartTotals(items: CartItem[]) {
  return {
    totalItems: items.reduce((sum, i) => sum + i.quantity, 0),
    totalAmount: items.reduce((sum, i) => sum + i.unitAmount * i.quantity, 0),
  };
}
