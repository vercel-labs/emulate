"use client";

import { createContext, useContext, useState, useCallback, type ReactNode } from "react";

export interface CartItem {
  priceId: string;
  productName: string;
  unitAmount: number;
  currency: string;
  quantity: number;
}

interface CartContextValue {
  items: CartItem[];
  totalItems: number;
  totalAmount: number;
  addItem: (item: Omit<CartItem, "quantity">) => void;
  updateQuantity: (priceId: string, delta: number) => void;
  removeItem: (priceId: string) => void;
  clearCart: () => void;
}

const CartContext = createContext<CartContextValue | null>(null);

function writeCookie(items: CartItem[]) {
  if (items.length === 0) {
    document.cookie = "cart=; path=/; max-age=0";
  } else {
    document.cookie = `cart=${encodeURIComponent(JSON.stringify(items))}; path=/; max-age=86400`;
  }
}

export function CartProvider({ initialItems, children }: { initialItems: CartItem[]; children: ReactNode }) {
  const [items, setItems] = useState(initialItems);

  const addItem = useCallback((item: Omit<CartItem, "quantity">) => {
    setItems((prev) => {
      const existing = prev.find((i) => i.priceId === item.priceId);
      const next = existing
        ? prev.map((i) => (i.priceId === item.priceId ? { ...i, quantity: i.quantity + 1 } : i))
        : [...prev, { ...item, quantity: 1 }];
      writeCookie(next);
      return next;
    });
  }, []);

  const updateQuantity = useCallback((priceId: string, delta: number) => {
    setItems((prev) => {
      const next = prev
        .map((i) => (i.priceId === priceId ? { ...i, quantity: i.quantity + delta } : i))
        .filter((i) => i.quantity > 0);
      writeCookie(next);
      return next;
    });
  }, []);

  const removeItem = useCallback((priceId: string) => {
    setItems((prev) => {
      const next = prev.filter((i) => i.priceId !== priceId);
      writeCookie(next);
      return next;
    });
  }, []);

  const clearCart = useCallback(() => {
    writeCookie([]);
    setItems([]);
  }, []);

  const totalItems = items.reduce((sum, i) => sum + i.quantity, 0);
  const totalAmount = items.reduce((sum, i) => sum + i.unitAmount * i.quantity, 0);

  return (
    <CartContext value={{ items, totalItems, totalAmount, addItem, updateQuantity, removeItem, clearCart }}>
      {children}
    </CartContext>
  );
}

export function useCart() {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error("useCart must be used within CartProvider");
  return ctx;
}
