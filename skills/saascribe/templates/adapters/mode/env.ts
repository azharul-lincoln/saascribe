import type { ModeSource, StripeCredentials, StripeMode } from "../../ports.ts";

/**
 * One Stripe mode per deployment, from the environment (recommended): staging runs test, production
 * runs live. `STRIPE_MODE` picks it; each mode reads its own secrets, so a missing live secret
 * fails loudly instead of quietly charging in test.
 *
 *   STRIPE_MODE=live
 *   STRIPE_SECRET_KEY_LIVE=rk_live_...   STRIPE_WEBHOOK_SECRET_LIVE=whsec_...
 *   STRIPE_SECRET_KEY_TEST=rk_test_...   STRIPE_WEBHOOK_SECRET_TEST=whsec_...
 *
 * Pass the runtime's env reader: `(name) => Deno.env.get(name)` or `(name) => process.env[name]`.
 */
export function envModeSource(readEnv: (name: string) => string | undefined): ModeSource {
  const read = (name: string) => {
    const value = readEnv(name)?.trim();
    return value ? value : null;
  };
  return {
    async activeMode(): Promise<StripeMode> {
      const mode = read("STRIPE_MODE");
      if (mode !== "test" && mode !== "live") throw new Error(`STRIPE_MODE must be "test" or "live", got ${JSON.stringify(mode)}`);
      return mode;
    },
    credentials(mode: StripeMode): StripeCredentials {
      const suffix = mode === "live" ? "LIVE" : "TEST";
      return { mode, secretKey: read(`STRIPE_SECRET_KEY_${suffix}`), webhookSecret: read(`STRIPE_WEBHOOK_SECRET_${suffix}`) };
    },
  };
}
