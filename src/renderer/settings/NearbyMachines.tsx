import { useCallback, useEffect, useState } from "react";
import { RotateCw } from "lucide-react";
import { errorMessage } from "../../workbench/error-message";
import type { UiDiscoveredHosts } from "../../shared/discovery";
import { NearbyMachineList } from "./NearbyMachineList";
import { useHostClient } from "../host-client-context";
import { Dialog } from "../components/ui/Dialog";
import { DialogClose } from "../pairing/dialog-parts";
import { Button, SettingsState } from "./controls";

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
      setSearch({ status: "error", message: errorMessage(error) });
    }
  }, [client]);
  useEffect(() => { void look(); }, [look]);

  return (
    <Dialog className="confirm-dialog nearby-machines-dialog" label="Machines on this network" onClose={onClose}>
      <h2>Machines on this network</h2>
      <p>A machine lets another in only after its owner allows it.</p>
      <div className="nearby-machines-body" aria-busy={search.status === "searching"}>
        {search.status === "searching" ? (
          <SettingsState kind="loading" rows={2} title="Looking for machines" />
        ) : search.status === "error" ? (
          <SettingsState kind="error" title="Looking failed" description={search.message} onRetry={() => void look()} />
        ) : (
          <NearbyMachineList result={search.result} />
        )}
      </div>
      <footer>
        <Button icon={<RotateCw size={13} />} busy={search.status === "searching"} onClick={() => void look()}>Search again</Button>
      </footer>
      <DialogClose onClose={onClose} />
    </Dialog>
  );
}
