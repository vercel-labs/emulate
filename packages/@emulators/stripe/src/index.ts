export const serviceName = "stripe";
export const serviceLabel = "Stripe billing and payments API";
export const runtime = "native-go";

export interface CompatEntity {
  id: number;
  created_at: string;
  updated_at: string;
  [key: string]: unknown;
}

export type CompatInsertInput<T extends CompatEntity> = Omit<T, "id" | "created_at" | "updated_at"> & { id?: number };

export interface CompatQueryOptions<T> {
  filter?: (item: T) => boolean;
  sort?: (a: T, b: T) => number;
  page?: number;
  per_page?: number;
}

export interface CompatPaginatedResult<T> {
  items: T[];
  total_count: number;
  page: number;
  per_page: number;
  has_next: boolean;
  has_prev: boolean;
}

export interface CompatCollection<T extends CompatEntity = CompatEntity> {
  readonly fieldNames?: string[];
  insert(data: CompatInsertInput<T>): T;
  get(id: number): T | undefined;
  findBy(field: keyof T, value: T[keyof T] | string | number): T[];
  findOneBy(field: keyof T, value: T[keyof T] | string | number): T | undefined;
  update(id: number, data: Partial<T>): T | undefined;
  delete(id: number): boolean;
  all(): T[];
  query(options?: CompatQueryOptions<T>): CompatPaginatedResult<T>;
  count(filter?: (item: T) => boolean): number;
  clear(): void;
  snapshot(): unknown;
  restore(snapshot: unknown): void;
}

export interface CompatStoreSource {
  collection<T extends CompatEntity>(name: string, indexFields?: string[]): CompatCollection<T>;
}

export type PaymentIntentStatus =
  | "requires_payment_method"
  | "requires_confirmation"
  | "requires_action"
  | "processing"
  | "succeeded"
  | "canceled";

export interface StripeCustomer extends CompatEntity {
  [key: string]: unknown;
}
export interface StripeProduct extends CompatEntity {
  [key: string]: unknown;
}
export interface StripePrice extends CompatEntity {
  [key: string]: unknown;
}
export interface StripePaymentIntent extends CompatEntity {
  [key: string]: unknown;
}
export interface StripeCharge extends CompatEntity {
  [key: string]: unknown;
}
export interface StripeCheckoutSession extends CompatEntity {
  [key: string]: unknown;
}

export interface StripeSeedConfig {
  [key: string]: unknown;
}

export interface StripeStore {
  customers: CompatCollection<StripeCustomer>;
  products: CompatCollection<StripeProduct>;
  prices: CompatCollection<StripePrice>;
  paymentIntents: CompatCollection<StripePaymentIntent>;
  charges: CompatCollection<StripeCharge>;
  checkoutSessions: CompatCollection<StripeCheckoutSession>;
}

function compatCollection<T extends CompatEntity>(
  store: CompatStoreSource,
  name: string,
  indexFields: string[],
): CompatCollection<T> {
  return store.collection<T>(name, indexFields);
}

export function getStripeStore(store: CompatStoreSource): StripeStore {
  return {
    customers: compatCollection<StripeCustomer>(store, "stripe.customers", ["stripe_id", "email"]),
    products: compatCollection<StripeProduct>(store, "stripe.products", ["stripe_id"]),
    prices: compatCollection<StripePrice>(store, "stripe.prices", ["stripe_id", "product_id"]),
    paymentIntents: compatCollection<StripePaymentIntent>(store, "stripe.payment_intents", [
      "stripe_id",
      "customer_id",
    ]),
    charges: compatCollection<StripeCharge>(store, "stripe.charges", ["stripe_id", "customer_id", "payment_intent_id"]),
    checkoutSessions: compatCollection<StripeCheckoutSession>(store, "stripe.checkout_sessions", [
      "stripe_id",
      "customer_id",
    ]),
  };
}

// Legacy public entity type augmentations.
export interface StripeCustomer extends CompatEntity {
  stripe_id: string;
  email: string | null;
  name: string | null;
  description: string | null;
  metadata: Record<string, string>;
}

export interface StripeProduct extends CompatEntity {
  stripe_id: string;
  name: string;
  description: string | null;
  active: boolean;
  metadata: Record<string, string>;
}

export interface StripePrice extends CompatEntity {
  stripe_id: string;
  product_id: string;
  currency: string;
  unit_amount: number | null;
  type: "one_time" | "recurring";
  active: boolean;
  metadata: Record<string, string>;
}

export interface StripePaymentIntent extends CompatEntity {
  stripe_id: string;
  amount: number;
  currency: string;
  status: PaymentIntentStatus;
  customer_id: string | null;
  description: string | null;
  payment_method: string | null;
  metadata: Record<string, string>;
}

export interface StripeCharge extends CompatEntity {
  stripe_id: string;
  amount: number;
  currency: string;
  status: "succeeded" | "pending" | "failed";
  customer_id: string | null;
  payment_intent_id: string | null;
  description: string | null;
  metadata: Record<string, string>;
}

export interface StripeCheckoutSession extends CompatEntity {
  stripe_id: string;
  mode: "payment" | "setup" | "subscription";
  status: "open" | "complete" | "expired";
  payment_status: "paid" | "unpaid" | "no_payment_required";
  customer_id: string | null;
  success_url: string | null;
  cancel_url: string | null;
  line_items: Array<{ price: string; quantity: number }>;
  metadata: Record<string, string>;
}

// Legacy public seed config type augmentations.
export interface StripeSeedConfig {
  port?: number;
  customers?: Array<{
    id?: string;
    email?: string;
    name?: string;
    description?: string;
  }>;
  products?: Array<{
    id?: string;
    name: string;
    description?: string;
  }>;
  prices?: Array<{
    id?: string;
    product_name: string;
    currency: string;
    unit_amount: number;
  }>;
  webhooks?: Array<{
    url: string;
    events: string[];
    secret?: string;
  }>;
}
export const service = {
  name: serviceName,
  label: serviceLabel,
  runtime,
} as const;

export const plugin = {
  ...service,
  register(): void {
    return undefined;
  },
  seed(): void {
    return undefined;
  },
} as const;

export const stripePlugin = plugin;

export function seedFromConfig(_store?: unknown, _baseUrl?: string, _config?: StripeSeedConfig): void {
  throw new Error(
    "seedFromConfig is no longer supported by native compatibility facade packages. Pass seed data to createEmulateHandler or createEmulator instead.",
  );
}

export function createAppKeyResolver(): undefined {
  return undefined;
}

export default plugin;
