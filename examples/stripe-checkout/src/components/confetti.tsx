"use client";

import { useEffect } from "react";
import confetti from "canvas-confetti";

export function Confetti() {
  useEffect(() => {
    const burst = (origin: { x: number; y: number }) =>
      confetti({
        particleCount: 80,
        spread: 70,
        origin,
        colors: ["#635bff", "#22c55e", "#f59e0b", "#ef4444", "#0ea5e9"],
        scalar: 0.9,
      });

    burst({ x: 0.2, y: 0.6 });
    setTimeout(() => burst({ x: 0.8, y: 0.6 }), 150);
    setTimeout(() => burst({ x: 0.5, y: 0.4 }), 300);
  }, []);

  return null;
}
