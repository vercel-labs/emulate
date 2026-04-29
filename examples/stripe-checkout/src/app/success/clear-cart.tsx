"use client";

import { useEffect } from "react";
import { clearCartAction } from "@/app/actions";

export function ClearCart() {
  useEffect(() => {
    clearCartAction();
  }, []);
  return null;
}
