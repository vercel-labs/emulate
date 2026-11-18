import type { ConsoleService } from "./types";

const auth = { Authorization: "Bearer sk_test_emulated" };
const form = { ...auth, "Content-Type": "application/x-www-form-urlencoded" };

export const stripe: ConsoleService = {
  name: "stripe",
  label: "Stripe",
  description:
    "Customers, products, prices, checkout sessions, payment intents, and charges. Seeded with customer cus_playground and four products.",
  variables: [
    {
      name: "customer_id",
      label: "Customer id",
      hint: "Filled in when you run Create customer. You can also paste an id.",
    },
    {
      name: "checkout_session_id",
      label: "Checkout session id",
      hint: "Filled in when you run Create checkout session. You can also paste an id.",
    },
    {
      name: "payment_intent_id",
      label: "Payment intent id",
      hint: "Filled in when you run Create payment intent. You can also paste an id.",
    },
    {
      name: "open_payment_intent_id",
      label: "Open payment intent id",
      hint: "Filled in when you run Create intent to cancel. You can also paste an id.",
    },
    {
      name: "charge_id",
      label: "Charge id",
      hint: "Filled in when you run List charges. You can also paste an id.",
    },
  ],
  groups: [
    {
      title: "Customers",
      presets: [
        {
          label: "Create customer",
          description: "Creates a customer and saves its id for Delete customer.",
          method: "POST",
          path: "/v1/customers",
          headers: form,
          body: "email=jenny.rosen@example.com&name=Jenny+Rosen&description=Created+from+the+playground",
          captures: { customer_id: "id" },
        },
        {
          label: "List customers",
          description: "Lists customers, including the seeded cus_playground.",
          method: "GET",
          path: "/v1/customers?limit=10",
          headers: auth,
        },
        {
          label: "Retrieve customer",
          description: "Fetches the seeded customer cus_playground.",
          method: "GET",
          path: "/v1/customers/cus_playground",
          headers: auth,
        },
        {
          label: "Update customer",
          description: "Changes the description of the seeded customer cus_playground.",
          method: "POST",
          path: "/v1/customers/cus_playground",
          headers: form,
          body: "description=Updated+from+the+playground",
        },
        {
          label: "Delete customer",
          description: "Deletes the customer saved by Create customer.",
          method: "DELETE",
          path: "/v1/customers/{{customer_id}}",
          headers: auth,
        },
      ],
    },
    {
      title: "Products",
      presets: [
        {
          label: "Create product",
          description: "Creates a product. Add a price with Create price before you check it out.",
          method: "POST",
          path: "/v1/products",
          headers: form,
          body: "name=Emulate+Cap&description=Keep+the+sun+out",
        },
        {
          label: "List products",
          description: "Lists active products, including the four seeded ones.",
          method: "GET",
          path: "/v1/products?active=true&limit=10",
          headers: auth,
        },
        {
          label: "Retrieve product",
          description: "Fetches the seeded hoodie, prod_hoodie.",
          method: "GET",
          path: "/v1/products/prod_hoodie",
          headers: auth,
        },
      ],
    },
    {
      title: "Prices",
      presets: [
        {
          label: "Create price",
          description: "Adds a one-time USD price of $40.00 to the seeded hoodie.",
          method: "POST",
          path: "/v1/prices",
          headers: form,
          body: "product=prod_hoodie&currency=usd&unit_amount=4000",
        },
        {
          label: "List prices",
          description: "Lists prices for the seeded hoodie.",
          method: "GET",
          path: "/v1/prices?product=prod_hoodie",
          headers: auth,
        },
        {
          label: "Retrieve price",
          description: "Fetches the seeded hoodie price, price_hoodie.",
          method: "GET",
          path: "/v1/prices/price_hoodie",
          headers: auth,
        },
      ],
    },
    {
      title: "Checkout sessions",
      presets: [
        {
          label: "Create checkout session",
          description: "Starts a checkout for the seeded customer and hoodie price, and saves its id.",
          method: "POST",
          path: "/v1/checkout/sessions",
          headers: form,
          body: "mode=payment&customer=cus_playground&line_items[0][price]=price_hoodie&line_items[0][quantity]=1&success_url=https://example.com/success?session_id={CHECKOUT_SESSION_ID}&cancel_url=https://example.com/cart",
          captures: { checkout_session_id: "id" },
        },
        {
          label: "List checkout sessions",
          description: "Lists checkout sessions, up to ten per page.",
          method: "GET",
          path: "/v1/checkout/sessions?limit=10",
          headers: auth,
        },
        {
          label: "Retrieve checkout session",
          description: "Fetches the checkout session saved by Create checkout session.",
          method: "GET",
          path: "/v1/checkout/sessions/{{checkout_session_id}}",
          headers: auth,
        },
        {
          label: "Expire checkout session",
          description: "Expires the open checkout session saved by Create checkout session.",
          method: "POST",
          path: "/v1/checkout/sessions/{{checkout_session_id}}/expire",
          headers: auth,
        },
      ],
    },
    {
      title: "Payment intents",
      presets: [
        {
          label: "Create payment intent",
          description: "Creates a $20.00 payment intent for the seeded customer and saves its id.",
          method: "POST",
          path: "/v1/payment_intents",
          headers: form,
          body: "amount=2000&currency=usd&customer=cus_playground&description=Playground+order",
          captures: { payment_intent_id: "id" },
        },
        {
          label: "List payment intents",
          description: "Lists payment intents for the seeded customer.",
          method: "GET",
          path: "/v1/payment_intents?customer=cus_playground&limit=10",
          headers: auth,
        },
        {
          label: "Retrieve payment intent",
          description: "Fetches the payment intent saved by Create payment intent.",
          method: "GET",
          path: "/v1/payment_intents/{{payment_intent_id}}",
          headers: auth,
        },
        {
          label: "Update payment intent",
          description: "Changes the amount of the saved payment intent to $25.00.",
          method: "POST",
          path: "/v1/payment_intents/{{payment_intent_id}}",
          headers: form,
          body: "amount=2500",
        },
        {
          label: "Confirm payment intent",
          description: "Confirms the saved payment intent, marks it succeeded, and creates a charge.",
          method: "POST",
          path: "/v1/payment_intents/{{payment_intent_id}}/confirm",
          headers: form,
          body: "payment_method=pm_card_visa",
        },
        {
          label: "Create intent to cancel",
          description:
            "Creates a second $20.00 payment intent, since confirmed intents cannot be canceled, and saves its id for Cancel payment intent.",
          method: "POST",
          path: "/v1/payment_intents",
          headers: form,
          body: "amount=2000&currency=usd&customer=cus_playground&description=Playground+order+to+cancel",
          captures: { open_payment_intent_id: "id" },
        },
        {
          label: "Cancel payment intent",
          description: "Cancels the unconfirmed payment intent saved by Create intent to cancel.",
          method: "POST",
          path: "/v1/payment_intents/{{open_payment_intent_id}}/cancel",
          headers: auth,
        },
      ],
    },
    {
      title: "Charges",
      presets: [
        {
          label: "List charges",
          description: "Lists charges and saves the first charge id. Confirming a payment intent creates one.",
          method: "GET",
          path: "/v1/charges?limit=10",
          headers: auth,
          captures: { charge_id: "data.0.id" },
        },
        {
          label: "Retrieve charge",
          description: "Fetches the charge saved by List charges.",
          method: "GET",
          path: "/v1/charges/{{charge_id}}",
          headers: auth,
        },
      ],
    },
    {
      title: "Payment methods",
      presets: [
        {
          label: "List payment methods",
          description: "Lists payment methods for the seeded customer. The emulator returns an empty list.",
          method: "GET",
          path: "/v1/payment_methods?customer=cus_playground",
          headers: auth,
        },
      ],
    },
    {
      title: "Customer sessions",
      presets: [
        {
          label: "Create customer session",
          description:
            "Creates a short-lived session that lets client-side Stripe components act for the seeded customer.",
          method: "POST",
          path: "/v1/customer_sessions",
          headers: form,
          body: "customer=cus_playground&components[buy_button][enabled]=true",
        },
      ],
    },
  ],
};
