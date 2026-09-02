import { useEffect, useState } from "react";
import { ChevronDown, Gauge } from "lucide-react";
import { SERVICE_TIER_EVENT, SERVICE_TIER_HOST_EXTENSION_ID, type ServiceTier, type ServiceTierState } from "../../shared/service-tier-protocol";
import { HostUnavailableError, type ComposerControlProps, type DesktopExtension, type HostExtensionClient } from "../extension-system";
import { Menu } from "../components/Menu";

const UNKNOWN: ServiceTierState = { tier: "standard", available: false };

function isState(value: unknown): value is ServiceTierState {
  const state = value as Partial<ServiceTierState> | null;
  return Boolean(state && (state.tier === "standard" || state.tier === "fast") && typeof state.available === "boolean");
}

function createControl(host: HostExtensionClient, notify: (message: string) => void) {
  return function ServiceTierControl({ snapshot }: ComposerControlProps) {
    const [state, setState] = useState<ServiceTierState>(UNKNOWN);
    const [open, setOpen] = useState(false);
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
      <span className="menu-anchor composer-runtime-menu-anchor">
        <button className="runtime-chip" title="Service tier" onClick={() => setOpen((current) => !current)}>
          <Gauge size={13} />
          {state.tier === "fast" ? "fast" : "standard"}
          <ChevronDown size={12} className="chev" />
        </button>
        {open ? (
          <Menu
            placement="above"
            heading="Service tier"
            items={[
              { id: "standard", label: "Standard", badge: "Default", selected: state.tier === "standard" },
              {
                id: "fast",
                label: "Fast",
                description: state.available ? "Priority routing, higher cost" : "Not offered for this model's provider",
                selected: state.tier === "fast",
                disabled: !state.available,
              },
            ]}
            onSelect={(id) => void setTier(id as ServiceTier)}
            onClose={() => setOpen(false)}
          />
        ) : null}
      </span>
    );
  };
}

export const serviceTierKitExtension: DesktopExtension = {
  id: SERVICE_TIER_HOST_EXTENSION_ID,
  name: "Service Tier",
  activate(plugin) {
    let notify: (message: string) => void = (message) => console.warn(message);
    plugin.registerComposerControl({ id: "service-tier.chip", order: 20, Component: createControl(plugin.host, (message) => notify(message)) });
    for (const tier of ["standard", "fast"] as const) {
      plugin.registerCommand({
        id: `service-tier.${tier}`,
        label: `Service tier: ${tier}`,
        group: "Runtime",
        run: async (actions) => {
          notify = actions.notify;
          try { await plugin.host.invoke("set-tier", { tier }); }
          catch (error) { actions.notify(error instanceof Error ? error.message : String(error)); }
        },
      });
    }
  },
};
