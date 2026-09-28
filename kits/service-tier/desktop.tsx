import { useEffect, useState } from "react";
import { Gauge } from "lucide-react";
import { ComposerMenuItem, ComposerMenuSection, HostUnavailableError, type ComposerControlProps, type DesktopExtension, type HostExtensionClient } from "tau";
import { SERVICE_TIER_EVENT, SERVICE_TIER_HOST_EXTENSION_ID, type ServiceTier, type ServiceTierState } from "./protocol.js";

const UNKNOWN: ServiceTierState = { tier: "standard", available: false };

function isState(value: unknown): value is ServiceTierState {
  const state = value as Partial<ServiceTierState> | null;
  return Boolean(state && (state.tier === "standard" || state.tier === "fast") && typeof state.available === "boolean");
}

function createControl(host: HostExtensionClient, notify: (message: string) => void) {
  return function ServiceTierControl({ snapshot }: ComposerControlProps) {
    const [state, setState] = useState<ServiceTierState>(UNKNOWN);
    const model = snapshot?.model;
    // The host decides availability from the active model's API, so ask again
    // whenever the thread or its model changes, and whenever the host says so.
    useEffect(() => {
      let cancelled = false;
      const read = () => host.invoke("state").then((value) => {
        if (!cancelled && isState(value)) setState(value);
      }).catch((error: unknown) => {
        if (!(error instanceof HostUnavailableError)) console.warn("Service Tier Kit could not read the tier", error);
      });
      void read();
      const off = host.onEvent(SERVICE_TIER_EVENT, (payload) => { if (isState(payload)) setState(payload); });
      return () => { cancelled = true; off(); };
    }, [snapshot?.sessionId, model?.provider, model?.id]);

    if (!state.available && state.tier === "standard") return null;
    const setTier = (tier: ServiceTier) => host.invoke("set-tier", { tier })
      .then((value) => { if (isState(value)) setState(value); })
      .catch((error: unknown) => notify(error instanceof Error ? error.message : String(error)));
    return (
      <ComposerMenuSection heading="Service tier">
        <ComposerMenuItem icon={<Gauge size={13} />} label="Standard" selected={state.tier === "standard"} onSelect={() => void setTier("standard")} />
        <ComposerMenuItem
          icon={<Gauge size={13} />}
          label="Fast"
          detail="Priority routing, higher cost"
          selected={state.tier === "fast"}
          disabled={!state.available}
          disabledReason="Not offered for this model's provider"
          onSelect={() => void setTier("fast")}
        />
      </ComposerMenuSection>
    );
  };
}

export const serviceTierKitExtension: DesktopExtension = {
  id: SERVICE_TIER_HOST_EXTENSION_ID,
  name: "Service Tier",
  activate(plugin) {
    let notify: (message: string) => void = (message) => console.warn(message);
    plugin.registerComposerControl({ id: "service-tier.chip", placement: "menu", order: 20, profiles: ["desktop", "web", "compact"], Component: createControl(plugin.host, (message) => notify(message)) });
    for (const tier of ["standard", "fast"] as const) {
      plugin.registerCommand({
        id: `service-tier.${tier}`,
        label: `Service tier: ${tier}`,
        group: "Runtime",
        access: "write",
        run: async (actions) => {
          notify = actions.notify;
          try { await plugin.host.invoke("set-tier", { tier }); }
          catch (error) { actions.notify(error instanceof Error ? error.message : String(error)); }
        },
      });
    }
  },
};

export default serviceTierKitExtension;
