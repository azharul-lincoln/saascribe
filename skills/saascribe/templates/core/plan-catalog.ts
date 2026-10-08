import type Stripe from "stripe";
import { type BillingConfig, type Interval, isInterval, normalizePlanId } from "./config.ts";

/**
 * Which Stripe price belongs to which plan, built from the prices Stripe returns.
 *
 * A plan is a Stripe product tagged `metadata[productMetadataKey] = <plan id>`. The plan of a
 * subscription is read from its price through this map, never from `subscription.metadata`:
 * metadata is written once at checkout and goes stale the moment the price changes.
 *
 * Archived prices stay in the map so an old subscription still resolves to its plan.
 * Nothing here creates products or prices; a missing plan is an error, not a guess.
 */

export interface PlanPrice {
  plan: string;
  interval: Interval;
}

export interface PlanCatalog {
  /** The price checkout sells for each `plan:interval`: newest active price on the newest active product. */
  sellingPrice: Map<string, Stripe.Price>;
  /** Every known price, archived ones included. */
  byPrice: Map<string, PlanPrice>;
  /** Product to plan, for a price that is not in the list (created after the catalog was read). */
  planByProduct: Map<string, string>;
  /** Every sellable price per `plan:interval`, for the audit: more than one is a dashboard mistake. */
  sellablePriceIds: Map<string, string[]>;
}

export const catalogKey = (plan: string, interval: Interval) => `${plan}:${interval}`;

function productOf(price: Stripe.Price): Stripe.Product | null {
  const product = price.product;
  if (!product || typeof product === "string" || ("deleted" in product && product.deleted)) return null;
  return product as Stripe.Product;
}

function intervalOf(config: BillingConfig, price: Stripe.Price): Interval | null {
  if ((price.recurring?.interval_count ?? 1) !== 1) return null;
  const interval = price.recurring?.interval;
  return isInterval(config, interval) ? interval : null;
}

/** `prices` must be listed with `expand: ["data.product"]` and `type: "recurring"`. */
export function buildPlanCatalog(config: BillingConfig, prices: Stripe.Price[]): PlanCatalog {
  const byPrice = new Map<string, PlanPrice>();
  const planByProduct = new Map<string, string>();
  const sellable = new Map<string, { price: Stripe.Price; product: Stripe.Product }[]>();

  for (const price of prices) {
    const product = productOf(price);
    const plan = normalizePlanId(config, product?.metadata?.[config.productMetadataKey]);
    const interval = intervalOf(config, price);
    if (!product || !plan) continue;
    planByProduct.set(product.id, plan);
    if (!interval) continue;
    byPrice.set(price.id, { plan, interval });
    if (product.active && price.active && price.currency === config.currency) {
      const key = catalogKey(plan, interval);
      sellable.set(key, [...(sellable.get(key) ?? []), { price, product }]);
    }
  }

  const sellingPrice = new Map<string, Stripe.Price>();
  const sellablePriceIds = new Map<string, string[]>();
  for (const [key, entries] of sellable) {
    entries.sort((a, b) => b.product.created - a.product.created || b.price.created - a.price.created);
    sellablePriceIds.set(key, entries.map((entry) => entry.price.id));
    sellingPrice.set(key, entries[0].price);
  }
  return { sellingPrice, byPrice, planByProduct, sellablePriceIds };
}

export function getSellingPrice(catalog: PlanCatalog, plan: string, interval: Interval): Stripe.Price {
  const price = catalog.sellingPrice.get(catalogKey(plan, interval));
  if (!price) {
    throw new Error(`No active ${interval}ly price for plan "${plan}". Create one in Stripe on the plan's product.`);
  }
  return price;
}

/** The plan and interval a price stands for, or null when it is not one of ours. */
export function planOfPrice(
  config: BillingConfig,
  catalog: PlanCatalog,
  price: string | Stripe.Price | Stripe.DeletedPrice | null | undefined,
): PlanPrice | null {
  if (!price) return null;
  const id = typeof price === "string" ? price : price.id;
  const known = catalog.byPrice.get(id);
  if (known) return known;
  if (typeof price === "string" || !("product" in price) || !price.product) return null;
  const productId = typeof price.product === "string" ? price.product : price.product.id;
  const plan = catalog.planByProduct.get(productId);
  const interval = intervalOf(config, price as Stripe.Price);
  return plan && interval ? { plan, interval } : null;
}
