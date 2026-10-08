import type Stripe from "stripe";
import type { BillingConfig } from "../core/config.ts";
import { buildPlanCatalog, type PlanCatalog } from "../core/plan-catalog.ts";
import type { StripeMode } from "../ports.ts";

/**
 * Reads the plan catalog from Stripe, cached per mode for a few minutes. Throws when Stripe
 * cannot be read: callers must not fall back to a guessed plan.
 */
const CACHE_MS = 5 * 60_000;
const cache = new Map<StripeMode, { catalog: PlanCatalog; at: number }>();

export async function loadCatalog(
  stripe: Stripe,
  config: BillingConfig,
  mode: StripeMode,
  options: { fresh?: boolean } = {},
): Promise<PlanCatalog> {
  const hit = cache.get(mode);
  if (!options.fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.catalog;

  const prices: Stripe.Price[] = [];
  for await (const price of stripe.prices.list({ type: "recurring", limit: 100, expand: ["data.product"] })) {
    prices.push(price);
  }
  const catalog = buildPlanCatalog(config, prices);
  cache.set(mode, { catalog, at: Date.now() });
  return catalog;
}
