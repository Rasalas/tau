import { useCallback, useEffect, useState } from "react";
import { RadioTower } from "lucide-react";
import type { UiDiscoveredHosts } from "../../shared/discovery";
import { NearbyMachineList } from "./NearbyMachineList";
import { useHostClient } from "../host-client-context";
import { Dialog } from "../components/ui/Dialog";
import { Empty, Skeleton } from "../components/ui/Feedback";

type Search =
  | { status: "searching" }
  | { status: "done"; result: UiDiscoveredHosts }
  | { status: "error"; message: string };

/**
 * Looks for Tau hosts that announce themselves with Bonjour. It looks only
 * while open: browsing is what makes macOS ask about local network access.
 */
export function NearbyMachinesDialog({ onClose }: { onClose(): void }) {
  const client = useHostClient();
  const [search, setSearch] = useState<Search>({ status: "searching" });
  const look = useCallback(async () => {
    if (!client) return;
    setSearch({ status: "searching" });
    try {
      setSearch({ status: "done", result: await client.discoverHosts() });
    } catch (error: unknown) {
      setSearch({ status: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }, [client]);
  useEffect(() => { void look(); }, [look]);

  return (
    <Dialog className="confirm-dialog nearby-machines-dialog" label="Machines on this network" onClose={onClose}>
      <h2>Machines on this network</h2>
      <p>A machine lets another in only after its owner allows it.</p>
      <div className="nearby-machines-body" aria-busy={search.status === "searching"}>
        {search.status === "searching" ? (
          <>
            <p className="nearby-machines-status" role="status">Looking…</p>
            <Skeleton shape="block" className="nearby-machines-skeleton" />
          </>
        ) : search.status === "error" ? (
          <Empty size="compact" icon={<RadioTower size={16} />} title="Looking failed" description={search.message} />
        ) : (
          <NearbyMachineList result={search.result} />
        )}
      </div>
      <footer>
        <button type="button" className="text-button" disabled={search.status === "searching"} onClick={() => void look()}>Search Again</button>
        <button type="button" className="primary" onClick={onClose}>Done</button>
      </footer>
    </Dialog>
  );
}
