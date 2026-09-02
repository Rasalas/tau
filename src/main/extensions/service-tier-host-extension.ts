import { SERVICE_TIER_EVENT, SERVICE_TIER_HOST_EXTENSION_ID, isServiceTier, type ServiceTier, type ServiceTierState } from "../../shared/service-tier-protocol.js";
import type { HostExtension, HostExtensionContext } from "../host-extensions.js";
import { createServiceTierExtension, SERVICE_TIER_APIS } from "../service-tier-extension.js";

/**
 * Service Tier Kit's host entry. It owns the chosen tier, contributes the Pi
 * extension that rewrites provider requests, and reports whether the active
 * model's API offers a priority tier at all.
 */
export function createServiceTierHostExtension(): HostExtension {
  return {
    id: SERVICE_TIER_HOST_EXTENSION_ID,
    name: "Service Tier",
    activate(context: HostExtensionContext) {
      const { services } = context;
      let tier: ServiceTier = "standard";
      /** Threads and models the priority tier was already reported for; every request applies it. */
      const reported = new Set<string>();
      const available = (sessionId?: string) => {
        const api = services.thread(sessionId)?.modelApi();
        return Boolean(api && SERVICE_TIER_APIS.has(api));
      };
      const state = (): ServiceTierState => ({ tier, available: available() });

      services.registerRuntimeExtension("tau-service-tier", createServiceTierExtension({
        fastRequested: () => tier === "fast",
        available: () => available(),
        onApplied: (scope) => {
          if (reported.has(scope)) return;
          reported.add(scope);
          services.log("service-tier.applied", `priority · ${scope.slice(0, 8)}${scope.slice(36)}`);
        },
      }));
      context.registerCommand("state", () => state());
      context.registerCommand("set-tier", (input) => {
        const requested = input && typeof input === "object" ? (input as { tier?: unknown }).tier : undefined;
        if (!isServiceTier(requested)) throw new Error("Service tier must be standard or fast.");
        if (requested !== tier) {
          tier = requested;
          reported.clear();
          services.log("service-tier.changed", tier);
          context.emit(SERVICE_TIER_EVENT, state());
        }
        return state();
      });
    },
  };
}
