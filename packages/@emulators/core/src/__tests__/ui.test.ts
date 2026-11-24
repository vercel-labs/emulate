import { describe, expect, it } from "vitest";
import { callbackRegistrationError } from "../oauth-helpers.js";
import { renderCheckoutPage, renderFormPostPage } from "../ui.js";

describe("addresses placed in emulator pages", () => {
  it("posts a form_post response only to an http or https address", () => {
    const page = renderFormPostPage("https://app.example.com/callback", { code: "c" }, "Apple");
    expect(page).toContain('action="https://app.example.com/callback"');

    for (const target of ["javascript:alert(1)", "data:text/html,x", "not a url"]) {
      const refused = renderFormPostPage(target, { code: "c" }, "Apple");
      expect(refused).not.toContain("<form");
      expect(refused).toContain("Invalid redirect URI");
    }
  });

  it("leaves out a checkout cancel link that is not an http or https address", () => {
    const order = { lineItems: [], subtotal: 0, total: 0, currency: "usd", sessionId: "cs_1" };
    const safe = renderCheckoutPage({ ...order, cancelUrl: "https://shop.example.com/cart" }, "Stripe");
    const unsafe = renderCheckoutPage({ ...order, cancelUrl: "javascript:alert(1)" }, "Stripe");

    expect(safe).toContain('href="https://shop.example.com/cart"');
    expect(unsafe).not.toContain("javascript:");
  });
});

describe("callbackRegistrationError", () => {
  const clients = [{ client_id: "app", redirect_uris: ["https://app.example.com/callback"] }];

  it("accepts anything while no client is registered", () => {
    expect(callbackRegistrationError("whoever", "https://anywhere.example.com", [])).toBeNull();
  });

  it("accepts a registered client only at one of its own redirect URIs", () => {
    expect(callbackRegistrationError("app", "https://app.example.com/callback", clients)).toBeNull();
    expect(callbackRegistrationError("other", "https://app.example.com/callback", clients)?.title).toBe(
      "Application not found",
    );
    for (const target of ["https://evil.example.com/callback", "javascript:alert(1)", ""]) {
      expect(callbackRegistrationError("app", target, clients)?.title).toBe("Redirect URI mismatch");
    }
  });
});
