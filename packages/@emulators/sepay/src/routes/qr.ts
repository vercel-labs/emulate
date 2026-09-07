import type { Context, RouteContext } from "@emulators/core";
import { buildVietQrString } from "../vietqr.js";
import { renderQrPng } from "../png.js";

export function qrRoutes({ app }: RouteContext): void {
  const handler = (c: Context): Response => {
    const acc = c.req.query("acc");
    const bank = c.req.query("bank");
    if (!acc || !bank) return c.text("Missing required params: acc, bank", 400);
    const payload = buildVietQrString({
      acc,
      bank,
      amount: c.req.query("amount"),
      des: c.req.query("des"),
    });
    return new Response(new Uint8Array(renderQrPng(payload)), {
      status: 200,
      headers: { "Content-Type": "image/png" },
    });
  };

  app.get("/img", (c) => handler(c));
  app.get("/qr/img", (c) => handler(c));
}
