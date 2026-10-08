import Stripe from "stripe";

/**
 * The one Stripe SDK copy and API version for every billing service. Nothing else in the app
 * should construct a Stripe client, so every call goes out on the same version and object shapes
 * never mix.
 *
 * `stripe` 23.x pins 2026-09-30.endive. Moving to a newer version is a deliberate migration:
 * read `references/api-versions.md`, bump the SDK and this constant together, and create new
 * webhook endpoints on the new version.
 */
export const STRIPE_API_VERSION = "2026-09-30.endive" as const;

export function createStripe(secretKey: string): Stripe {
  return new Stripe(secretKey, {
    apiVersion: STRIPE_API_VERSION,
    maxNetworkRetries: 2,
    appInfo: { name: "saascribe-billing" },
  });
}

export type { Stripe };
