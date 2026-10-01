import { HostUnavailableError, type ComposerSpeedContribution, type ComposerSpeedState, type DesktopExtension, type HostExtensionClient } from "tau";
import { SERVICE_TIER_EVENT, SERVICE_TIER_HOST_EXTENSION_ID, type ServiceTierState } from "./protocol.js";

function isState(value: unknown): value is ServiceTierState {
  const state = value as Partial<ServiceTierState> | null;
  return Boolean(state && (state.tier === "standard" || state.tier === "fast") && typeof state.available === "boolean");
}

/**
 * Fast for Pi threads, drawn by core in the thinking chip (K142). The tier is
 * the host's, asked again whenever the thread or its model changes and
 * whenever the host says so; the host sends it only where the model's API takes it.
 */
export function createServiceTierSpeed(host: HostExtensionClient): ComposerSpeedContribution {
  let asked: string | undefined;
  let held: ComposerSpeedState | undefined;
  let stopEvents: (() => void) | undefined;
  const listeners = new Set<() => void>();
  let tier: ServiceTierState | undefined;
  let openai = true;
  // The host answers for the thread on screen, a draft's model may be another's: the provider decides what is offered.
  const shape = () => {
    if (tier) held = openai
      ? { fast: tier.tier === "fast", available: true, detail: "Priority routing, higher cost" }
      : { fast: tier.tier === "fast", available: false, reason: "Pi offers Fast for OpenAI models only" };
  };
  const publish = (state: ServiceTierState) => {
    tier = state;
    shape();
    for (const listener of listeners) listener();
  };
  return {
    id: "service-tier.speed",
    profiles: ["desktop", "web", "compact"],
    read(snapshot) {
      if (snapshot?.backendKind && snapshot.backendKind !== "pi") return undefined;
      const key = `${snapshot?.sessionId}|${snapshot?.model?.provider}/${snapshot?.model?.id}`;
      if (key !== asked) {
        asked = key;
        openai = !snapshot?.model || /^(openai|azure-openai)/u.test(snapshot.model.provider);
        shape();
        void host.invoke("state").then((value) => { if (isState(value)) publish(value); }).catch((error: unknown) => {
          if (!(error instanceof HostUnavailableError)) console.warn("Service Tier Kit could not read the tier", error);
        });
      }
      return held;
    },
    subscribe(listener) {
      listeners.add(listener);
      stopEvents ??= host.onEvent(SERVICE_TIER_EVENT, (payload) => { if (isState(payload)) publish(payload); });
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) { stopEvents?.(); stopEvents = undefined; }
      };
    },
    async set(fast) {
      const value = await host.invoke("set-tier", { tier: fast ? "fast" : "standard" });
      if (isState(value)) publish(value);
    },
  };
}

export const serviceTierKitExtension: DesktopExtension = {
  id: SERVICE_TIER_HOST_EXTENSION_ID,
  name: "Service Tier",
  activate(plugin) {
    plugin.registerComposerSpeed(createServiceTierSpeed(plugin.host));
    for (const tier of ["standard", "fast"] as const) {
      plugin.registerCommand({
        id: `service-tier.${tier}`,
        label: `Service tier: ${tier}`,
        group: "Runtime",
        access: "write",
        run: async (actions) => {
          try { await plugin.host.invoke("set-tier", { tier }); }
          catch (error) { actions.notify(error instanceof Error ? error.message : String(error)); }
        },
      });
    }
  },
};

export default serviceTierKitExtension;
