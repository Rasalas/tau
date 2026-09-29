import { useMemo, useSyncExternalStore } from "react";
import { hostUpdatePending, machineBehind, type HostUpdatePhase, type HostUpdateStatus } from "../shared/host-updates";
import { hostUpdateStore, type HostUpdateStore, type HostUpdateView } from "../workbench/host-update-store";
import { useHostClient } from "./host-client-context";
import { usePlatform } from "./platform-context";

const EMPTY: HostUpdateView = {};
const noSubscription = () => () => undefined;

/** The connected host's own Tau and what can be asked of it (K103). */
export function useHostUpdate(): HostUpdateView & { store?: HostUpdateStore } {
  const client = useHostClient();
  const store = useMemo(() => (client ? hostUpdateStore(client) : undefined), [client]);
  const view = useSyncExternalStore(store?.subscribe ?? noSubscription, () => store?.getSnapshot() ?? EMPTY);
  return store ? { ...view, store } : view;
}

/** One machine with a newer Tau to install. */
export interface MachineUpdate {
  /** The machine's host id; absent for a host that did not say it. */
  id?: string;
  name: string;
  /** The window's own machine, or the host a browser or phone talks to. */
  local: boolean;
  version?: string;
  latest?: string;
  phase?: HostUpdatePhase;
}

export interface MachineUpdates {
  /** Machines behind, this one included; empty when all are current. */
  pending: MachineUpdate[];
  /** The connected host's own status, where it reports one. */
  host?: HostUpdateStatus;
}

function entry(base: { id?: string; name: string; local: boolean }, update: HostUpdateStatus | undefined, version: string | undefined): MachineUpdate {
  return {
    ...base,
    ...(update?.version ?? version ? { version: update?.version ?? version } : {}),
    ...(update?.latest ? { latest: update.latest } : {}),
    ...(update ? { phase: update.phase } : {}),
  };
}

/**
 * Whether any machine this client reaches runs an older Tau than it could
 * (K103), for an "Update available" mark: the window's machines from its own
 * connections, or else the one host this client talks to. A machine counts
 * when its host knows a newer release, or when it runs an older Tau than this
 * window.
 */
export function useMachineUpdates(): MachineUpdates {
  const client = useHostClient();
  const environments = usePlatform().environments;
  const host = useHostUpdate();
  const list = useSyncExternalStore(environments?.subscribe ?? noSubscription, () => environments?.getSnapshot());
  const reference = client?.getVersions().window;
  return useMemo(() => {
    if (list) {
      const pending = list.environments
        .filter((machine) => machineBehind(machine, reference))
        .map((machine) => entry({ id: machine.id, name: machine.name, local: machine.local }, machine.update, machine.hostVersion));
      return { pending, ...(host.status ? { host: host.status } : {}) };
    }
    if (!host.status || !hostUpdatePending(host.status)) return { pending: [], ...(host.status ? { host: host.status } : {}) };
    const name = client?.getHostName?.() ?? "This machine";
    return { pending: [entry({ name, local: true }, host.status, undefined)], host: host.status };
  }, [client, host.status, list, reference]);
}
