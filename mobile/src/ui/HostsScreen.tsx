import { useEffect, useRef, useState } from "react";
import { Monitor, Plus, QrCode, Trash2, Wifi, X } from "lucide-react";
import { Switch } from "../../../src/renderer/settings/controls";
import { useFocusReturn, useFocusTrap } from "../../../src/renderer/components/ui/focus";
import type { DiscoveredHost } from "../discovery";
import { sortHosts, type SavedHost } from "../hosts";

/** Where the Bonjour browse stands; the list below it says so in words. */
export type NearbyState =
  | { state: "searching"; hosts: DiscoveredHost[] }
  | { state: "denied" }
  | { state: "failed"; message: string }
  | { state: "unavailable" };

export interface HostRowInfo {
  host: SavedHost;
  /** The token is gone (revoked, expired): opening it means pairing again. */
  signedOut: boolean;
  /** Seen on this network right now. */
  nearby: boolean;
  remoteActivity?: import("../activity-start").RemoteActivityStatus;
}

const MINUTE = 60_000;

export function usedAgo(iso: string | undefined, now: number): string | undefined {
  if (!iso) return undefined;
  const elapsed = now - Date.parse(iso);
  if (!Number.isFinite(elapsed)) return undefined;
  if (elapsed < MINUTE) return "used just now";
  if (elapsed < 60 * MINUTE) return `used ${Math.floor(elapsed / MINUTE)} min ago`;
  if (elapsed < 24 * 60 * MINUTE) return `used ${Math.floor(elapsed / (60 * MINUTE))} h ago`;
  return `used ${Math.floor(elapsed / (24 * 60 * MINUTE))} d ago`;
}

const KIND_LABEL: Record<string, string> = { lan: "Local network", mdns: "Local network", tailscale: "Tailscale", magicdns: "Tailscale", loopback: "This computer" };

/** "Local network · 192.168.1.20 · used 5 min ago": how the phone reached it last, and when. */
export function hostMeta(row: HostRowInfo, now: number): string {
  if (row.signedOut) return "Access ended. Open it to pair again.";
  const parts: string[] = [];
  if (row.nearby) parts.push("On this network");
  const endpoint = row.host.lastEndpoint;
  if (endpoint && !row.nearby) {
    let address = endpoint.url;
    try { address = new URL(endpoint.url).hostname; } catch { /* keep the URL */ }
    parts.push(endpoint.kind ? `${KIND_LABEL[endpoint.kind] ?? endpoint.kind} · ${address}` : address);
  }
  if (row.host.access === "read-only") parts.push("read only");
  const used = usedAgo(row.host.lastUsedAt, now);
  if (used) parts.push(used);
  return parts.join(" · ");
}

/**
 * The start screen: hosts this phone paired with, hosts on this network it
 * could ask, and Add host as the floating button at the bottom right.
 */
export function HostsScreen({ rows, nearby, notice, onOpen, onRemove, onRemoteActivity, onAdd, onDemo, onScan, onAsk, now = Date.now() }: {
  rows: HostRowInfo[];
  nearby: NearbyState;
  notice?: string;
  onOpen(host: SavedHost): void;
  onRemove(host: SavedHost): void;
  onRemoteActivity?(host: SavedHost, enabled: boolean): void;
  onAdd(): void;
  onDemo?(): void;
  onScan(): void;
  onAsk(host: DiscoveredHost): void;
  now?: number;
}) {
  const [removing, setRemoving] = useState<SavedHost>();
  const sorted = sortHosts(rows.map((row) => row.host)).map((host) => rows.find((row) => row.host.id === host.id)!);
  const saved = new Set(rows.map((row) => row.host.id));
  const unknownNearby = nearby.state === "searching" ? nearby.hosts.filter((host) => !saved.has(host.hostId)) : [];
  return <main className="shell-screen" aria-labelledby="hosts-title">
    <header className="shell-header"><h1 id="hosts-title">Hosts</h1></header>
    <div className="shell-scroll">
      {notice ? <p className="shell-notice" role="alert">{notice}</p> : null}
      {sorted.length > 0 ? <ul className="shell-list" aria-label="Paired hosts">
        {sorted.map((row) => <li key={row.host.id} className="shell-row shell-paired-host" data-signed-out={row.signedOut ? "" : undefined}>
          <div className="shell-host-main-row"><button type="button" className="shell-row-main" aria-label={`Open ${row.host.name}`} onClick={() => onOpen(row.host)}>
            <span className="shell-row-icon" aria-hidden="true">{row.nearby ? <Wifi size={20} /> : <Monitor size={20} />}</span>
            <span className="shell-row-text">
              <strong>{row.host.name}</strong>
              <small>{hostMeta(row, now)}</small>
            </span>
          </button>
          <button type="button" className="shell-icon-button" aria-label={`Remove ${row.host.name}`} title="Remove" onClick={() => setRemoving(row.host)}><Trash2 size={19} /></button></div>
          {(row.remoteActivity?.available || row.remoteActivity?.enabled) && !row.signedOut && onRemoteActivity ? <div className="shell-activity-setting">
            <span><strong>Live Activities</strong><small>Updates on your Lock Screen</small></span>
            <Switch role="checkbox" label={`Remote Live Activities for ${row.host.name}`} checked={row.remoteActivity.enabled} onChange={(enabled) => onRemoteActivity(row.host, enabled)} />
          </div> : null}
        </li>)}
      </ul> : <div className="shell-empty">
        <strong>No hosts yet</strong>
        <p>On the computer running Tau, open Settings → Connections, create a pairing link and scan its code.</p>
        <button type="button" onClick={onScan}><QrCode size={18} />Scan a pairing code</button>
      </div>}

      {onRemoteActivity && sorted.some((row) => row.remoteActivity?.available || row.remoteActivity?.enabled) ? <p className="shell-hint">Live Activities can start while Tau is closed. Turning them off ends current activities too.</p> : null}
      <section className="shell-section" aria-labelledby="nearby-title">
        <h2 id="nearby-title">On this network</h2>
        <NearbyList state={nearby} hosts={unknownNearby} onAsk={onAsk} />
      </section>
      <p className="shell-hint"><a href="https://tbuck.de/privacy/tau/" target="_blank" rel="noopener noreferrer">Privacy policy</a></p>
      {onDemo ? <section className="shell-demo" aria-label="Local demo">
        <button type="button" className="shell-secondary" onClick={onDemo}>Try demo</button>
        <p className="shell-hint">Explore sample threads with scripted replies. No computer or AI account needed. Demo messages disappear when you exit.</p>
      </section> : null}
    </div>
    <button type="button" className="shell-fab" aria-label="Add host" onClick={onAdd}><Plus size={28} /></button>
    {removing ? <RemoveDialog host={removing} onKeep={() => setRemoving(undefined)} onRemove={() => { onRemove(removing); setRemoving(undefined); }} /> : null}
  </main>;
}

function NearbyList({ state, hosts, onAsk }: { state: NearbyState; hosts: DiscoveredHost[]; onAsk(host: DiscoveredHost): void }) {
  if (state.state === "denied") return <p className="shell-hint">Tau may not look for hosts on this network. Allow Local Network for Tau in the system settings, or scan a pairing code instead.</p>;
  if (state.state === "failed") return <p className="shell-hint">Looking for hosts on this network failed: {state.message}</p>;
  if (state.state === "unavailable") return <p className="shell-hint">This device cannot look for hosts on the network. Scan a pairing code instead.</p>;
  if (hosts.length === 0) return <p className="shell-hint" role="status">Looking for Tau hosts… A host shows up here while Local network is on in its Settings → Connections.</p>;
  return <ul className="shell-list" aria-label="Hosts on this network">
    {hosts.map((host) => <li key={host.hostId} className="shell-row">
      <button type="button" className="shell-row-main" aria-label={`Ask ${host.name} to connect`} onClick={() => onAsk(host)}>
        <span className="shell-row-icon" aria-hidden="true"><Wifi size={20} /></span>
        <span className="shell-row-text">
          <strong>{host.name}</strong>
          <small>Ask to connect · the owner allows it on the host</small>
        </span>
      </button>
    </li>)}
  </ul>;
}

/** Names what goes and what stays: the host keeps listing the phone until its owner revokes it. */
function RemoveDialog({ host, onKeep, onRemove }: { host: SavedHost; onKeep(): void; onRemove(): void }) {
  const surface = useRef<HTMLDivElement>(null);
  useFocusReturn(true, surface);
  useFocusTrap(surface, true);
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") onKeep(); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onKeep]);
  return <div className="shell-scrim" onClick={(event) => { if (event.target === event.currentTarget) onKeep(); }}>
    <div ref={surface} className="shell-dialog" role="alertdialog" aria-modal="true" aria-labelledby="remove-title" aria-describedby="remove-text" tabIndex={-1}>
      <header>
        <h2 id="remove-title">Remove {host.name}?</h2>
        <button type="button" className="shell-icon-button" aria-label="Close" onClick={onKeep}><X size={20} /></button>
      </header>
      <p id="remove-text">This phone forgets the host and its access. {host.name} still lists this phone until you revoke it there, in Settings → Connections.</p>
      <div className="shell-actions">
        <button type="button" className="shell-danger" onClick={onRemove}>Remove</button>
        <button type="button" className="shell-secondary" onClick={onKeep}>Keep</button>
      </div>
    </div>
  </div>;
}
