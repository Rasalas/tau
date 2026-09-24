import type { ReactNode } from "react";
import { Monitor, RadioTower } from "lucide-react";
import type { DiscoveredHost, UiDiscoveredHosts } from "../../shared/discovery";
import { Empty } from "../components/ui/Feedback";

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
