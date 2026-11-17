"use client";

import { useEffect, useState } from "react";
import { flowUrl, recall, remember, takeReturnQuery } from "@/lib/playground/round-trip";
import { getEmulator } from "@/lib/playground/runtime";
import {
  cardClass,
  labelClass,
  mutedClass,
  primaryButtonClass,
  secondaryButtonClass,
} from "@/components/playground/ui";

type Step = "store" | "success";
type Pending = "catalog" | "checkout" | "confirm";

interface Product {
  id: string;
  name: string;
}

interface Price {
  id: string;
  product: string;
  currency: string;
  unit_amount: number | null;
}

interface Customer {
  id: string;
  name: string | null;
  email: string | null;
}

interface CheckoutSession {
  id: string;
  url: string | null;
  customer: string | null;
  payment_status: string;
}

interface CatalogItem {
  productId: string;
  name: string;
  image?: string;
  priceId: string;
  unitAmount: number;
  currency: string;
}

interface Line extends CatalogItem {
  quantity: number;
}

interface Order {
  session: CheckoutSession;
  lines: Line[];
}

interface Confirmation {
  session: CheckoutSession;
  customer: Customer | null;
}

const auth = { Authorization: "Bearer sk_test_emulated" };
const formHeaders = { ...auth, "Content-Type": "application/x-www-form-urlencoded" };
const ORDER = "checkout.order";
const shopper = { email: "shopper@example.com", name: "Demo Shopper" };

const images: Record<string, string> = {
  prod_hoodie: "/playground/products/hoodie.webp",
  prod_stickers: "/playground/products/stickers.webp",
  prod_mug: "/playground/products/mug.webp",
  prod_tshirt: "/playground/products/tshirt.webp",
};

const pendingText: Record<Pending, string> = {
  catalog: "Loading products...",
  checkout: "Opening the Stripe checkout page...",
  confirm: "Loading the paid order...",
};

function formBody(fields: Record<string, string>) {
  return new URLSearchParams(fields).toString();
}

function money(amount: number, currency: string) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount / 100);
}

function totalOf(lines: Line[]) {
  const currency = lines[0]?.currency ?? "usd";
  return money(
    lines.reduce((sum, line) => sum + line.unitAmount * line.quantity, 0),
    currency,
  );
}

function describeError(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong. Try again.";
}

function emulatorErrorMessage(text: string) {
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string } };
    return parsed.error?.message ?? null;
  } catch {
    return null;
  }
}

/** Calls the Stripe emulator and parses its JSON, throwing with the emulator's message on a non-2xx answer. */
async function emulatorCall<T>(path: string, init?: RequestInit): Promise<T> {
  const stripe = await getEmulator("stripe");
  const response = await stripe.fetch(path, init);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(emulatorErrorMessage(text) ?? `The emulator answered ${response.status}.`);
  }
  return JSON.parse(text) as T;
}

function fetchCatalog(): Promise<CatalogItem[]> {
  return Promise.all([
    emulatorCall<{ data: Product[] }>("/v1/products?active=true&limit=10", { headers: auth }),
    emulatorCall<{ data: Price[] }>("/v1/prices?active=true&limit=100", { headers: auth }),
  ]).then(([products, prices]) => buildCatalog(products.data, prices.data));
}

function buildCatalog(products: Product[], prices: Price[]): CatalogItem[] {
  return products.flatMap((product) => {
    const price = prices.find((candidate) => candidate.product === product.id);
    if (price?.unit_amount == null) return [];
    return [
      {
        productId: product.id,
        name: product.name,
        image: images[product.id],
        priceId: price.id,
        unitAmount: price.unit_amount,
        currency: price.currency,
      },
    ];
  });
}

/**
 * A small store that pays through Stripe Checkout: the browser leaves for the emulator's hosted checkout page and
 * comes back with the paid session's id.
 */
export function CheckoutFlow() {
  const [catalog, setCatalog] = useState<CatalogItem[] | null>(null);
  const [bag, setBag] = useState<Record<string, number>>({});
  const [step, setStep] = useState<Step>("store");
  const [order, setOrder] = useState<Order | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [paidSession, setPaidSession] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>("catalog");
  const [error, setError] = useState<string | null>(null);

  const lines: Line[] = (catalog ?? []).flatMap((item) => {
    const quantity = bag[item.priceId];
    return quantity ? [{ ...item, quantity }] : [];
  });
  const busy = pending !== null;

  function loadCatalog() {
    return fetchCatalog()
      .then(setCatalog, (caught: unknown) => setError(describeError(caught)))
      .finally(() => setPending(null));
  }

  function retryCatalog() {
    setError(null);
    setPending("catalog");
    void loadCatalog();
  }

  function adjust(priceId: string, delta: number) {
    setBag((current) => {
      const quantity = (current[priceId] ?? 0) + delta;
      const next = { ...current };
      if (quantity > 0) next[priceId] = quantity;
      else delete next[priceId];
      return next;
    });
  }

  function removeLine(priceId: string) {
    setBag((current) => {
      const next = { ...current };
      delete next[priceId];
      return next;
    });
  }

  async function proceedToCheckout() {
    setPending("checkout");
    setError(null);
    try {
      const customer = await emulatorCall<Customer>("/v1/customers", {
        method: "POST",
        headers: formHeaders,
        body: formBody({ email: shopper.email, name: shopper.name }),
      });
      const back = flowUrl();
      const fields: Record<string, string> = {
        mode: "payment",
        customer: customer.id,
        success_url: `${back}?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${back}?cancelled=1`,
      };
      lines.forEach((line, index) => {
        fields[`line_items[${index}][price]`] = line.priceId;
        fields[`line_items[${index}][quantity]`] = String(line.quantity);
      });
      const session = await emulatorCall<CheckoutSession>("/v1/checkout/sessions", {
        method: "POST",
        headers: formHeaders,
        body: formBody(fields),
      });
      if (!session.url) throw new Error("The emulator returned no checkout page for this session.");
      remember(ORDER, { session, lines });
      window.location.assign(session.url);
    } catch (caught) {
      setError(describeError(caught));
      setPending(null);
    }
  }

  async function loadConfirmation(sessionId: string) {
    setPending("confirm");
    setError(null);
    try {
      const session = await emulatorCall<CheckoutSession>(`/v1/checkout/sessions/${sessionId}`, { headers: auth });
      const customer = session.customer
        ? await emulatorCall<Customer>(`/v1/customers/${session.customer}`, { headers: auth })
        : null;
      setConfirmation({ session, customer });
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setPending(null);
    }
  }

  useEffect(() => {
    const sessionId = takeReturnQuery().get("session_id");
    const saved = sessionId ? recall<Order>(ORDER) : null;
    void loadCatalog().then(() => {
      if (!sessionId) return undefined;
      if (saved?.session.id === sessionId) setOrder(saved);
      setPaidSession(sessionId);
      setStep("success");
      return loadConfirmation(sessionId);
    });
  }, []);

  function continueShopping() {
    setBag({});
    setOrder(null);
    setConfirmation(null);
    setError(null);
    setStep("store");
  }

  const statusText = pending ? pendingText[pending] : "";

  return (
    <div className="flex flex-col gap-6">
      <p aria-live="polite" className={mutedClass}>
        {statusText}
      </p>
      {error && (
        <p
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
        >
          {error}
        </p>
      )}

      {step === "store" && (
        <section data-flow-step="store" className="grid gap-8 md:grid-cols-[minmax(0,1fr)_18rem]">
          <div>
            {catalog === null ? (
              error && (
                <button type="button" onClick={retryCatalog} disabled={busy} className={secondaryButtonClass}>
                  Try loading products again
                </button>
              )
            ) : (
              <ul className="grid grid-cols-2 gap-4">
                {catalog.map((item) => (
                  <li
                    key={item.productId}
                    data-product={item.productId}
                    className={`${cardClass} flex flex-col gap-3 p-3`}
                  >
                    {item.image && (
                      <img
                        src={item.image}
                        alt={item.name}
                        width={640}
                        height={640}
                        className="aspect-square w-full rounded-md object-cover"
                      />
                    )}
                    <div className="flex flex-1 flex-col gap-1">
                      <p className={labelClass}>{item.name}</p>
                      <p className="font-mono text-sm tabular-nums text-neutral-600 dark:text-neutral-400">
                        {money(item.unitAmount, item.currency)}
                      </p>
                    </div>
                    <button
                      type="button"
                      data-add
                      aria-label={`Add ${item.name} to bag`}
                      onClick={() => adjust(item.priceId, 1)}
                      disabled={busy}
                      className={secondaryButtonClass}
                    >
                      Add to bag
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <aside aria-label="Bag" className={`${cardClass} flex h-fit flex-col gap-4`}>
            <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-100">Bag</h2>
            {lines.length === 0 ? (
              <p className={mutedClass}>Your bag is empty.</p>
            ) : (
              <ul className="flex flex-col gap-4">
                {lines.map((line) => (
                  <li key={line.priceId} className="flex flex-col gap-2 text-sm">
                    <div className="flex justify-between gap-2">
                      <span className="text-neutral-900 dark:text-neutral-100">{line.name}</span>
                      <span className="font-mono tabular-nums">
                        {money(line.unitAmount * line.quantity, line.currency)}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        aria-label={`Remove one ${line.name}`}
                        onClick={() => adjust(line.priceId, -1)}
                        disabled={busy}
                        className={secondaryButtonClass}
                      >
                        -
                      </button>
                      <span className="w-6 text-center font-mono tabular-nums">{line.quantity}</span>
                      <button
                        type="button"
                        aria-label={`Add one ${line.name}`}
                        onClick={() => adjust(line.priceId, 1)}
                        disabled={busy}
                        className={secondaryButtonClass}
                      >
                        +
                      </button>
                      <button
                        type="button"
                        aria-label={`Remove ${line.name} from bag`}
                        onClick={() => removeLine(line.priceId)}
                        disabled={busy}
                        className={`${secondaryButtonClass} ml-auto`}
                      >
                        Remove
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex justify-between border-t border-neutral-200 pt-4 text-sm font-medium dark:border-neutral-800">
              <span>Total</span>
              <span className="font-mono tabular-nums">{totalOf(lines)}</span>
            </div>
            <button
              type="button"
              data-checkout
              onClick={() => void proceedToCheckout()}
              disabled={busy || lines.length === 0}
              className={primaryButtonClass}
            >
              Proceed to checkout
            </button>
          </aside>
        </section>
      )}

      {step === "success" && (
        <section data-flow-step="success" className={`${cardClass} flex flex-col gap-6`}>
          {confirmation ? (
            <div data-flow-result className="flex flex-col gap-6">
              <div className="flex flex-col gap-1">
                <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">Order confirmed</h2>
                <p className={mutedClass}>The payment went through in the emulator.</p>
              </div>
              <dl className="grid gap-3 text-sm sm:grid-cols-[10rem_1fr]">
                <dt className="text-neutral-500 dark:text-neutral-400">Customer</dt>
                <dd>{confirmation.customer?.name ?? "Unknown"}</dd>
                <dt className="text-neutral-500 dark:text-neutral-400">Email</dt>
                <dd>{confirmation.customer?.email ?? "Unknown"}</dd>
                <dt className="text-neutral-500 dark:text-neutral-400">Session</dt>
                <dd className="font-mono break-all">{confirmation.session.id}</dd>
                <dt className="text-neutral-500 dark:text-neutral-400">Payment status</dt>
                <dd className="font-mono">{confirmation.session.payment_status}</dd>
                {order && (
                  <>
                    <dt className="text-neutral-500 dark:text-neutral-400">Total</dt>
                    <dd className="font-mono tabular-nums">{totalOf(order.lines)}</dd>
                  </>
                )}
              </dl>
            </div>
          ) : (
            error === null && <p className={mutedClass}>Loading the paid order...</p>
          )}
          {!confirmation && error && paidSession && (
            <button
              type="button"
              onClick={() => void loadConfirmation(paidSession)}
              disabled={busy}
              className={secondaryButtonClass}
            >
              Try loading the order again
            </button>
          )}
          <div>
            <button type="button" onClick={continueShopping} disabled={busy} className={primaryButtonClass}>
              Continue shopping
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
