import { useCallback, useEffect, useState } from "react";
import { Link2, Plus, X } from "lucide-react";
import type { UiConnections, UiCreatedPairingLink, UiNetworkSettingsInput, UiOwnerConnection, UiPairedClient, UiPairingLink } from "../../shared/connections";
import { useHostClient } from "../host-client-context";
import { ConfirmDialog } from "../components/ui/ConfirmDialog";
import { Dialog } from "../components/ui/Dialog";
import { Empty, Skeleton } from "../components/ui/Feedback";
import { SettingRow, SettingsSection } from "./settings-layout";
import { LINK_LIFETIMES, describeDevice, formatAgo, formatExpiresIn, qrEndpoint } from "./connections-format";
import { PairingQrCode } from "./PairingQrCode";
import { NetworkAccessSection } from "./NetworkAccessSection";

type PageState =
  | { status: "loading" }
  | { status: "error"; code?: string; message: string }
  | { status: "ready"; data: UiConnections };

function errorOf(error: unknown): { code?: string; message: string } {
  const code = typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : undefined;
  return { ...(code ? { code } : {}), message: error instanceof Error ? error.message : String(error) };
}

/** Relative times move on their own; a quarter minute is fine enough for "5 min ago". */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function StatusDot({ tone, label }: { tone: "live" | "idle" | "pending"; label: string }) {
  return <span className={`connection-dot ${tone}`} role="img" aria-label={label} title={label} />;
}

/**
 * Settings → Connections, after T3 Code's: where this host listens, who holds
 * a token for it, single-use pairing links for another device, and the host
 * token's rotation (ADR 0023). Only a connection with the host token sees it.
 */
export function ConnectionsPage({ onNotify }: { onNotify(message: string): void }) {
  const client = useHostClient();
  const [state, setState] = useState<PageState>({ status: "loading" });
  const [created, setCreated] = useState<UiCreatedPairingLink>();
  const [creating, setCreating] = useState(false);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [busy, setBusy] = useState<string>();
  const now = useNow(15_000);

  const refresh = useCallback(async () => {
    if (!client) return;
    try {
      setState({ status: "ready", data: await client.listConnections() });
    } catch (error: unknown) {
      setState({ status: "error", ...errorOf(error) });
    }
  }, [client]);

  useEffect(() => {
    void refresh();
    // A client arriving or leaving is the change this page shows most.
    return client?.onHostEvent((event) => { if (event.type === "client-count") void refresh(); });
  }, [client, refresh]);

  const act = async (key: string, run: () => Promise<unknown>, done?: string) => {
    setBusy(key);
    try {
      await run();
      if (done) onNotify(done);
    } catch (error: unknown) {
      onNotify(errorOf(error).message);
    } finally {
      setBusy(undefined);
      await refresh();
    }
  };

  const changeNetwork = async (input: UiNetworkSettingsInput, done: string): Promise<boolean> => {
    setBusy("network");
    try {
      await client!.setNetworkAccess(input);
      onNotify(done);
      return true;
    } catch (error: unknown) {
      onNotify(errorOf(error).message);
      return false;
    } finally {
      setBusy(undefined);
      await refresh();
    }
  };

  const copy = (text: string, what: string) => {
    void client?.copyText(text).then(() => onNotify(`${what} copied`), (error: unknown) => onNotify(errorOf(error).message));
  };

  if (state.status === "loading") {
    return <div className="settings-page" aria-busy="true"><Skeleton shape="card" /><Skeleton shape="card" /></div>;
  }
  if (state.status === "error") {
    const title = state.code === "forbidden" ? "Only the host’s owner manages connections"
      : state.code === "unsupported" || state.code === "unknown-method" ? "This host takes no other clients"
        : "Connections did not load";
    const description = state.code === "forbidden" ? "This client paired with a token of its own. Pairing links and revocations are made in a Tau window that holds the host token."
      : state.code === "unsupported" || state.code === "unknown-method" ? "It has no socket listener, so there is nobody to pair or revoke. The host a Tau window starts for itself has one."
        : state.message;
    return <div className="settings-page"><Empty icon={<Link2 size={18} />} title={title} description={description} /></div>;
  }

  const data = state.data;
  const links = data.links.filter((link) => Date.parse(link.expiresAt) > now);
  const nothing = links.length === 0 && data.clients.length === 0 && data.owners.length === 0;

  return (
    <div className="settings-page connections-page">
      <SettingsSection title="This host">
        <SettingRow
          title="Address"
          description={data.endpoints.some((endpoint) => endpoint.reachability === "network")
            ? "Other devices on these networks can open the host in a browser. A device picks whichever it reaches."
            : data.network
              ? "Reachable from this machine only. Turn on Local network or Tailscale below to pair another device."
              : "Reachable from this machine only. To pair another device, start the host with TAU_HOST_LISTEN=0.0.0.0:<port> and TAU_HOST_TLS=1."}
          status={<ul className="connection-endpoints">
            {data.endpoints.map((endpoint) => (
              <li key={endpoint.url} data-kind={endpoint.kind}><code>{endpoint.url}</code><small>{endpoint.label}</small></li>
            ))}
          </ul>}
        />
        {data.fingerprint ? (
          <SettingRow
            title="Certificate"
            description="A self-signed certificate is met with a browser warning. Trust it only if the browser shows this SHA-256 fingerprint."
            status={<code className="connection-fingerprint">{data.fingerprint}</code>}
          />
        ) : null}
        <SettingRow
          title="Host token"
          description={<>The owner’s key, kept in <code>{data.tokenPath}</code>. Rotating it disconnects every other client that uses it; paired clients keep their own tokens.</>}
          control={<button type="button" className="chrome-button" disabled={busy === "rotate"} onClick={() => setConfirmRotate(true)}>{busy === "rotate" ? "Rotating…" : "Rotate…"}</button>}
        />
      </SettingsSection>

      {data.network ? (
        <NetworkAccessSection
          network={data.network}
          busy={busy === "network" || busy === "reload"}
          onChange={changeNetwork}
          onReload={() => void act("reload", async () => {
            const { changed } = await client!.reloadCertificate();
            onNotify(changed ? "Tau now serves the renewed certificate" : "The certificate on disk is the one Tau serves");
          })}
        />
      ) : null}

      <SettingsSection
        title="Authorized clients"
        headerAction={(
          <button
            type="button"
            className="chrome-button accent"
            disabled={!data.webClient}
            title={data.webClient ? undefined : "This host serves no web client to pair with (npm run build:web)."}
            onClick={() => setCreating(true)}
          ><Plus size={13} /> Create link</button>
        )}
      >
        {/* Gone once used: the client it paired takes its place below. */}
        {created && links.some((link) => link.id === created.link.id)
          ? <CreatedLink created={created} now={now} onCopy={copy} onDismiss={() => setCreated(undefined)} />
          : null}
        {links.map((link) => (
          <LinkRow key={link.id} link={link} now={now} busy={busy === `link:${link.id}`}
            onRevoke={() => void act(`link:${link.id}`, async () => {
              await client?.revokePairingLink(link.id);
              if (created?.link.id === link.id) setCreated(undefined);
            }, "Pairing link revoked")} />
        ))}
        {data.clients.map((paired) => (
          <ClientRow key={paired.id} paired={paired} now={now} busy={busy === `client:${paired.id}`}
            onRevoke={() => void act(`client:${paired.id}`, () => client!.revokeClient(paired.id), `${paired.label} can no longer connect`)} />
        ))}
        {data.owners.map((owner) => <OwnerRow key={owner.id} owner={owner} now={now} />)}
        {nothing ? <p className="settings-group-note">No pairing links or clients.</p> : null}
      </SettingsSection>

      {creating ? (
        <CreateLinkDialog
          onCancel={() => setCreating(false)}
          onCreate={(input) => void act("create", async () => {
            const link = await client!.createPairingLink(input);
            setCreated(link);
            setCreating(false);
          })}
          busy={busy === "create"}
        />
      ) : null}
      {confirmRotate ? (
        <ConfirmDialog
          title="Rotate the host token?"
          message="Every other connection that uses the host token closes at once: other windows at this host, and any browser the token was pasted into. This window carries on with the new token."
          confirmLabel="Rotate Token"
          destructive
          onCancel={() => setConfirmRotate(false)}
          onConfirm={() => { setConfirmRotate(false); void act("rotate", () => client!.rotateHostToken(), "Host token rotated"); }}
        />
      ) : null}
    </div>
  );
}

function LinkRow({ link, now, busy, onRevoke }: { link: UiPairingLink; now: number; busy: boolean; onRevoke(): void }) {
  return (
    <div className="connection-row">
      <StatusDot tone="pending" label={`Created ${formatAgo(link.createdAt, now)}`} />
      <div className="connection-row-text">
        <strong>{link.label ?? "Pairing link"}</strong>
        <small title={new Date(link.expiresAt).toLocaleString()}>{formatExpiresIn(link.expiresAt, now)} · single use</small>
      </div>
      <button type="button" className="chrome-button danger" disabled={busy} onClick={onRevoke}>{busy ? "Revoking…" : "Revoke"}</button>
    </div>
  );
}

function ClientRow({ paired, now, busy, onRevoke }: { paired: UiPairedClient; now: number; busy: boolean; onRevoke(): void }) {
  const live = paired.connections > 0;
  const details = [describeDevice(paired.device), paired.lastAddress, `paired ${formatAgo(paired.pairedAt, now)}`,
    live ? "connected" : paired.lastSeenAt ? `last active ${formatAgo(paired.lastSeenAt, now)}` : "not connected yet"].filter(Boolean);
  return (
    <div className="connection-row">
      <StatusDot tone={live ? "live" : "idle"} label={live ? "Connected" : "Not connected"} />
      <div className="connection-row-text">
        <strong>{paired.label}{paired.current ? <em className="connection-badge">This device</em> : null}</strong>
        <small>{details.join(" · ")}</small>
      </div>
      {paired.current ? null : (
        <button type="button" className="chrome-button danger" disabled={busy} onClick={onRevoke}>{busy ? "Revoking…" : "Revoke"}</button>
      )}
    </div>
  );
}

function OwnerRow({ owner, now }: { owner: UiOwnerConnection; now: number }) {
  const name = owner.profile === "web" || owner.profile === "compact" ? "Browser" : "Tau window";
  const details = [describeDevice(owner.device), owner.address, `connected ${formatAgo(owner.since, now)}`, "host token"].filter(Boolean);
  return (
    <div className="connection-row">
      <StatusDot tone="live" label="Connected" />
      <div className="connection-row-text">
        <strong>{name}{owner.current ? <em className="connection-badge">This device</em> : null}</strong>
        <small>{details.join(" · ")}</small>
      </div>
    </div>
  );
}

function CreatedLink({ created, now, onCopy, onDismiss }: {
  created: UiCreatedPairingLink;
  now: number;
  onCopy(text: string, what: string): void;
  onDismiss(): void;
}) {
  const [chosen, setChosen] = useState<string>();
  const qr = qrEndpoint(created.urls, chosen);
  const shown = created.urls.find((endpoint) => endpoint.url === chosen) ?? qr ?? created.urls[0];
  return (
    <div className="connection-created" role="region" aria-label="New pairing link">
      <div className="connection-created-text">
        <div className="connection-created-head">
          <strong>{created.link.label ?? "Pairing link"} is ready</strong>
          <button type="button" className="text-button" aria-label="Hide the new link" onClick={onDismiss}><X size={13} /></button>
        </div>
        <p>Open it on the device you want to connect. It works once, {formatExpiresIn(created.link.expiresAt, now).toLowerCase()}, and this is the only time Tau shows it.</p>
        {created.urls.length > 1 ? (
          <div className="connection-endpoint-choice" role="radiogroup" aria-label="Address in the link">
            {created.urls.map((endpoint) => (
              <button key={endpoint.url} type="button" role="radio" aria-checked={endpoint === shown} className={endpoint === shown ? "active" : ""} onClick={() => setChosen(endpoint.url)}>
                {endpoint.label}
              </button>
            ))}
          </div>
        ) : null}
        {shown ? (
          <div className="connection-link-box">
            <code title={shown.url}>{shown.url}</code>
            <button type="button" className="chrome-button" onClick={() => onCopy(shown.url, "Pairing link")}>Copy link</button>
          </div>
        ) : <p>This host serves no web client, so the link has nothing to open.</p>}
        <button type="button" className="text-button connection-copy-code" onClick={() => onCopy(created.code, "Pairing code")}>Copy code only</button>
      </div>
      {shown && shown.reachability === "network" ? <PairingQrCode value={shown.url} /> : (
        <p className="connection-qr-missing">No QR code for a loopback address: a device that scans it would dial itself. Copy the link for a browser on this machine.</p>
      )}
    </div>
  );
}

function CreateLinkDialog({ busy, onCreate, onCancel }: { busy: boolean; onCreate(input: { label?: string; lifetimeMs: number }): void; onCancel(): void }) {
  const [label, setLabel] = useState("");
  const [lifetime, setLifetime] = useState(LINK_LIFETIMES[0]!.ms);
  const submit = () => onCreate({ ...(label.trim() ? { label: label.trim() } : {}), lifetimeMs: lifetime });
  return (
    <Dialog className="confirm-dialog connection-create-dialog" label="Create pairing link" onClose={onCancel}>
      <h2>Create pairing link</h2>
      <p>A one-time link another device opens to connect to this host with a token of its own. It never sees the host token.</p>
      <label className="connection-field">
        <span>Client label (optional)</span>
        <input
          className="settings-input"
          value={label}
          maxLength={60}
          placeholder="e.g. Kitchen iPad"
          disabled={busy}
          autoFocus
          onChange={(event) => setLabel(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); submit(); } }}
        />
      </label>
      <label className="connection-field">
        <span>Expires after</span>
        <select className="settings-select" value={lifetime} disabled={busy} onChange={(event) => setLifetime(Number(event.target.value))}>
          {LINK_LIFETIMES.map((entry) => <option key={entry.ms} value={entry.ms}>{entry.label}</option>)}
        </select>
      </label>
      <footer>
        <button type="button" className="text-button" onClick={onCancel}>Cancel</button>
        <button type="button" className="primary" disabled={busy} onClick={submit}>{busy ? "Creating…" : "Create Link"}</button>
      </footer>
    </Dialog>
  );
}
