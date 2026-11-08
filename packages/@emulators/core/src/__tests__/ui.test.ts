import { describe, it, expect } from "vitest";
import { renderCheckoutPage, renderPaymentMethodSelect, type CheckoutPageOptions } from "../ui.js";

const options = [
  { value: "pm_a", label: "Card A" },
  { value: "pm_b", label: "Card <B>", selected: true },
];

const page: CheckoutPageOptions = {
  lineItems: [],
  subtotal: 0,
  total: 0,
  currency: "usd",
  sessionId: "cs_1",
};

describe("renderPaymentMethodSelect", () => {
  it("renders the options as a payment_method select with the chosen one selected", () => {
    const html = renderPaymentMethodSelect(options);
    expect(html).toContain('<select name="payment_method" class="checkout-input">');
    expect(html).toContain('<option value="pm_a">Card A</option>');
    expect(html).toContain('<option value="pm_b" selected>Card &lt;B&gt;</option>');
    expect(html).not.toContain("checkout-sim-note");
  });

  it("puts the caller's note under the select", () => {
    const html = renderPaymentMethodSelect(options, "Pick <one>.");
    expect(html).toContain('<div class="checkout-sim-note">Pick &lt;one&gt;.</div>');
  });
});

describe("renderCheckoutPage", () => {
  it("shows the caller's note under the payment method select", () => {
    const html = renderCheckoutPage({ ...page, paymentMethodOptions: options, paymentMethodNote: "Custom note." });
    expect(html).toContain('<div class="checkout-sim-note">Custom note.</div>');
    expect(html).not.toContain("3D Secure");
  });

  it("names no provider behaviour in its default select note", () => {
    const html = renderCheckoutPage({ ...page, paymentMethodOptions: options });
    expect(html).toContain('<select name="payment_method"');
    expect(html).not.toContain("3D Secure");
  });

  it("keeps the simulated card fields when no options are given", () => {
    const html = renderCheckoutPage(page);
    expect(html).not.toContain('name="payment_method"');
    expect(html).toContain("Card fields are simulated.");
  });
});
