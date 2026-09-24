import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Monitor, RadioTower } from "lucide-react";
import type { DiscoveredHost, UiDiscoveredHosts } from "../../shared/discovery";
import { useHostClient } from "../host-client-context";
import { Dialog } from "../components/ui/Dialog";
import { Empty, Skeleton } from "../components/ui/Feedback";

type Search =
  | { status: "searching" }
  | { status: "done"; result: UiDiscoveredHosts }
  | { status: "error"; message: string };

/** `AB:CD:EF:01…`: enough to compare at a glance; the full one is in the tooltip. */
function shortFingerprint(fingerprint: string): string {
  return `${fingerprint.split(":").slice(0, 4).join(":")}…`;
}

function where(host: DiscoveredHost): string {
  const url = host.endpoints[0]?.url;
  return url ? new URL(url).host : `port ${host.port}`;
}

/** The hosts one search found; `action` lets a caller offer something per host. */
export function NearbyMachineList({ result, action }: { result: UiDiscoveredHosts; action?: (host: DiscoveredHost) => ReactNode }) {
  if (result.problem) {
    return <Empty size="compact" icon={<RadioTower size={16} />} title="Tau could not look on this network" description={result.problem} />;
  }
  if (result.hosts.length === 0) {
    return <Empty size="compact" icon={<RadioTower size={16} />} title="No Tau on this network" description="Turn on Local network and Announce on the other machine." />;
  }
  return (
    <ul className="nearby-machines" aria-label="Machines on this network">
      {result.hosts.map((host) => (
        <li key={`${host.hostId}:${host.port}`} className="connection-row">
          <Monitor size={15} aria-hidden="true" />
          <span className="connection-row-text">
            <strong>{host.name}{host.self ? <em className="connection-badge">This machine</em> : null}</strong>
            <small>{where(host)} · <span title={`SHA-256 ${host.fingerprint}`}>{shortFingerprint(host.fingerprint)}</span></small>
          </span>
          {action?.(host)}
        </li>
      ))}
    </ul>
  );
}

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
