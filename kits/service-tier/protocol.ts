/**
 * Service Tier Kit's contract between its host entry and its desktop entry.
 * Core has no notion of provider tiers; the kit rewrites requests through a Pi
 * extension and reports what the active model's API allows.
 */
export const SERVICE_TIER_HOST_EXTENSION_ID = "tau.service-tier";

export type ServiceTier = "standard" | "fast";

export interface ServiceTierState {
  tier: ServiceTier;
  /** False when the active model's API has no priority tier to ask for. */
  available: boolean;
}

/** Published by the host entry whenever the tier changes. */
export const SERVICE_TIER_EVENT = "state";

export function isServiceTier(value: unknown): value is ServiceTier {
  return value === "standard" || value === "fast";
}
