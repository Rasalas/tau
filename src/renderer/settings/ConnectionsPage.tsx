import { useCallback, useEffect, useState, type ComponentType } from "react";
import { Link2, Plus, SlidersHorizontal, X } from "lucide-react";
import {
  IDLE_EXPIRY_WARNING_MS,
  IDLE_TIMEOUT_CHOICES,
  type DeviceAccess,
  type IdleTimeoutDays,
  type UiClientUpdate,
  type UiConnections,
  type UiCreatedPairingLink,
  type UiNetworkSettingsInput,
  type UiOwnerConnection,
  type UiPairedClient,
  type UiPairingLink,
  type UiPairingRequest,
} from "../../shared/connections";
import { formatVerification } from "../../shared/pairing";
import { useHostClient } from "../host-client-context";
import { tooltipProps } from "../components/ui/Tooltip";
import { Dialog } from "../components/ui/Dialog";
import { Empty } from "../components/ui/Feedback";
import { Badge, Button, DangerAction, DangerZone, SegmentedControl, Select, SettingsState, TextField } from "./controls";
import { AccessChoice, PairingRequestDialog } from "../pairing/PairingRequestDialog";
import { DialogClose, submitOnEnter, useFieldValue } from "../pairing/dialog-parts";
import { requestTitle } from "../pairing/pairing-format";
import { SettingRow, SettingsSection } from "./settings-layout";
import { settingAnchor } from "./settings-search";
import { LINK_LIFETIMES, describeDevice, describeLastChange, formatAgo, formatExpiresIn, qrEndpoint } from "./connections-format";
import { PairingQrCode } from "./PairingQrCode";
import { NetworkAccessSection } from "./NetworkAccessSection";
import { NearbyMachinesDialog } from "./NearbyMachines";
import type { SettingsSectionProps } from "../extension-system";
import { HostServiceSection } from "./HostServiceSection";

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

/** What the host keeps of a device's or a link's name. */
const NAME_LIMIT = 60;

const idleLabel = (days: IdleTimeoutDays): string => (days === null ? "Never" : days === 365 ? "1 year unused" : `${days} days unused`);

/**
 * Settings → Connections: where this host listens, devices
 * waiting to be let in, who holds a token for it, single-use pairing links
 * for another device, and the host token's rotation (ADR 0023, ADR 0024).
 * Only a connection with the host token sees it.
 */
export function ConnectionsPage({ onNotify, sections = [] }: {
  onNotify(message: string): void;
  /** What packages add below Network access (`registerSettingsSection`). */
  sections?: ReadonlyArray<{ id: string; Component: ComponentType<SettingsSectionProps> }>;
}) {
  const client = useHostClient();
  const [state, setState] = useState<PageState>({ status: "loading" });
  const [created, setCreated] = useState<UiCreatedPairingLink>();
  const [creating, setCreating] = useState(false);
  const [reviewing, setReviewing] = useState<UiPairingRequest>();
  const [editing, setEditing] = useState<UiPairedClient>();
  const [findingMachines, setFindingMachines] = useState(false);
  const [busy, setBusy] = useState<string>();
  const now = useNow(15_000);

  const refresh = useCallback(async () => {
    if (!client) return;
    // The host would refuse it, and log the refusal of a device that only looked.
    if (client.isOwner?.() === false) {
      setState({ status: "error", code: "forbidden", message: "Only the host's own machine manages connections." });
      return;
    }
    try {
      setState({ status: "ready", data: await client.listConnections() });
    } catch (error: unknown) {
      setState({ status: "error", ...errorOf(error) });
    }
  }, [client]);

  useEffect(() => {
    void refresh();
    // A client arriving or leaving is the change this page shows most; a device asking is the most urgent.
    return client?.onHostEvent((event) => { if (event.type === "client-count" || event.type === "connections-changed") void refresh(); });
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
    return <div className="settings-page"><SettingsState kind="loading" rows={5} title="Loading connections" /></div>;
  }
  if (state.status === "error") {
    const title = state.code === "forbidden" ? "Connections are managed on the host’s machine"
      : state.code === "unsupported" || state.code === "unknown-method" ? "This host takes no other clients"
        : "Connections did not load";
    const description = state.code === "forbidden" ? "Pairing links, waiting devices and revocations are handled in a Tau window on the machine that runs the host, with the host token. A paired device, or the host token from another machine, can use the host but not change who may reach it."
      : state.code === "unsupported" || state.code === "unknown-method" ? "It has no socket listener, so there is nobody to pair or revoke. The host a Tau window starts for itself has one."
        : state.message;
    return <div className="settings-page">{state.code === "forbidden" || state.code === "unsupported" || state.code === "unknown-method"
      ? <Empty icon={<Link2 size={18} />} title={title} description={description} />
      : <SettingsState kind="error" title={title} description={description} onRetry={() => { setState({ status: "loading" }); void refresh(); }} />}</div>;
  }

  const data = state.data;
  const links = data.links.filter((link) => Date.parse(link.expiresAt) > now);
  const requests = data.requests ?? [];
  const nothing = links.length === 0 && requests.length === 0 && data.clients.length === 0 && data.owners.length === 0;
  const others = data.clients.filter((paired) => !paired.current).length;

  return (
    <div className="settings-page connections-page">
      <SettingsSection title="This host">
        <SettingRow
          id={settingAnchor("Address")}
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
            // Network access has its own Certificate row, which the search finds.
            {...(data.network ? {} : { id: settingAnchor("Certificate") })}
            title="Certificate"
            description="A self-signed certificate is met with a browser warning. Trust it only if the browser shows this SHA-256 fingerprint. Pairing links carry it, so the Tau app pins it without asking."
            status={<code className="connection-fingerprint">{data.fingerprint}</code>}
          />
        ) : null}
        <SettingRow
          id={settingAnchor("Other machines")}
          title="Other machines"
          description="Tau hosts nearby that announce themselves. macOS may ask about local network access the first time."
          control={<Button onClick={() => setFindingMachines(true)}>Find machines…</Button>}
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

      {sections.map(({ id, Component }) => <Component key={id} onNotify={onNotify} onChanged={() => void refresh()} />)}

      <SettingsSection
        id={settingAnchor("Authorized clients")}
        title="Authorized clients"
        headerAction={(
          <div className="connection-header-actions">
            <Button variant="primary" icon={<Plus size={14} />} onClick={() => setCreating(true)}
              {...tooltipProps(data.webClient ? undefined : "This build serves no web client, so only the Tau app can open a link.")}>Create link</Button>
          </div>
        )}
      >
        {requests.map((request) => (
          <RequestRow key={request.id} request={request} now={now} busy={busy === `request:${request.id}`}
            onReview={() => setReviewing(request)}
            onDeny={() => void act(`request:${request.id}`, () => client!.denyPairing(request.id), `${requestTitle(request)} was denied`)} />
        ))}
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
            {...(paired.companionOf ? { companionOf: data.clients.find((other) => other.id === paired.companionOf)?.label ?? "a device since revoked" } : {})}
            onEdit={() => setEditing(paired)}
            onRevoke={() => void act(`client:${paired.id}`, () => client!.revokeClient(paired.id), `${paired.label} can no longer connect`)} />
        ))}
        {data.owners.map((owner) => <OwnerRow key={owner.id} owner={owner} now={now} />)}
        {nothing ? <SettingsState kind="empty" title="No device is paired yet" description="Create a link and open it on a phone or another computer; you allow the device here when it asks." /> : null}
      </SettingsSection>

      <HostServiceSection onNotify={onNotify} />

      <DangerZone>
        <DangerAction
          id={settingAnchor("Sign out every other device")}
          title="Sign out every other device"
          description="Every paired device loses its token at once; each needs a new pairing to come back. Windows with the host token stay."
          actionLabel="Revoke others…"
          disabled={others === 0}
          disabledReason="No other device is paired."
          busy={busy === "revoke-others"}
          confirmTitle="Revoke every other device?"
          confirmMessage="Every paired device is signed out at once and its open connections close. Each needs a new pairing to come back. Windows with the host token are not affected."
          onConfirm={() => void act("revoke-others", async () => {
            const { revoked } = await client!.revokeOtherClients();
            onNotify(revoked === 1 ? "1 device signed out" : `${revoked} devices signed out`);
          })}
        />
        <DangerAction
          id={settingAnchor("Rotate the host token")}
          title="Rotate the host token"
          description={<>The owner’s key, kept in <code>{data.tokenPath}</code>. Every other connection that uses it closes; paired devices keep their own tokens.</>}
          actionLabel="Rotate…"
          busy={busy === "rotate"}
          confirmTitle="Rotate the host token?"
          confirmMessage="Every other connection that uses the host token closes at once: other windows at this host, and any browser the token was pasted into. This window carries on with the new token."
          onConfirm={() => void act("rotate", () => client!.rotateHostToken(), "Host token rotated")}
        />
      </DangerZone>

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
      {reviewing ? (
        <PairingRequestDialog
          request={reviewing}
          busy={busy === `request:${reviewing.id}`}
          onClose={() => setReviewing(undefined)}
          onDeny={() => void act(`request:${reviewing.id}`, async () => { await client!.denyPairing(reviewing.id); setReviewing(undefined); }, `${requestTitle(reviewing)} was denied`)}
          onAllow={(access) => void act(`request:${reviewing.id}`, async () => {
            const { approved } = await client!.approvePairing(reviewing.id, { access });
            setReviewing(undefined);
            if (!approved) throw new Error("The device stopped waiting before it was allowed.");
          }, `${requestTitle(reviewing)} can connect now`)}
        />
      ) : null}
      {editing ? (
        <DeviceDialog
          paired={editing}
          busy={busy === `edit:${editing.id}`}
          onCancel={() => setEditing(undefined)}
          onSave={(update) => void act(`edit:${editing.id}`, async () => { await client!.updateClient(editing.id, update); setEditing(undefined); })}
        />
      ) : null}
      {findingMachines ? <NearbyMachinesDialog onClose={() => setFindingMachines(false)} /> : null}
    </div>
  );
}

function LinkRow({ link, now, busy, onRevoke }: { link: UiPairingLink; now: number; busy: boolean; onRevoke(): void }) {
  return (
    <div className="connection-row">
      <StatusDot tone="pending" label={`Created ${formatAgo(link.createdAt, now)}`} />
      <div className="connection-row-text">
        <strong>{link.label ?? "Pairing link"}{link.access === "read-only" ? <Badge>Read only</Badge> : null}</strong>
        <small title={new Date(link.expiresAt).toLocaleString()}>{formatExpiresIn(link.expiresAt, now)} · single use · you allow the device when it asks</small>
      </div>
      <Button variant="danger" busy={busy} onClick={onRevoke}>{busy ? "Revoking…" : "Revoke"}</Button>
    </div>
  );
}

function RequestRow({ request, now, busy, onReview, onDeny }: { request: UiPairingRequest; now: number; busy: boolean; onReview(): void; onDeny(): void }) {
  const details = [describeDevice(request.device), request.address, request.link ? "with a pairing link" : "without a pairing link",
    request.companion ? `and its agents as “${request.companion.name}”` : undefined,
    formatExpiresIn(request.expiresAt, now).replace("Expires", "expires")].filter(Boolean);
  return (
    <div className="connection-row connection-request" role="group" aria-label={`${requestTitle(request)} wants to connect`}>
      <StatusDot tone="pending" label="Waiting for you" />
      <div className="connection-row-text">
        <strong>{requestTitle(request)} wants to connect <code className="connection-request-code">{formatVerification(request.verification)}</code></strong>
        <small>{details.join(" · ")}</small>
      </div>
      <Button variant="danger" disabled={busy} onClick={onDeny}>Deny</Button>
      <Button variant="primary" disabled={busy} onClick={onReview}>Allow…</Button>
    </div>
  );
}

function ClientRow({ paired, companionOf, now, busy, onEdit, onRevoke }: { paired: UiPairedClient; companionOf?: string; now: number; busy: boolean; onEdit(): void; onRevoke(): void }) {
  const live = paired.connections > 0;
  const details = [describeDevice(paired.device), companionOf ? `agents of ${companionOf}` : undefined, paired.lastAddress, paired.proxyUser ? `as ${paired.proxyUser}` : undefined, `paired ${formatAgo(paired.pairedAt, now)}`,
    live ? "connected" : paired.lastSeenAt ? `last active ${formatAgo(paired.lastSeenAt, now)}` : "not connected yet",
    paired.lastAction ? describeLastChange(paired.lastAction, now) : undefined].filter(Boolean);
  // Unused tokens run out; the owner hears of it a week ahead, the device only when it is refused.
  const expiring = !live && paired.expiresAt !== undefined && Date.parse(paired.expiresAt) - now < IDLE_EXPIRY_WARNING_MS;
  return (
    <div className="connection-row">
      <StatusDot tone={live ? "live" : "idle"} label={live ? "Connected" : "Not connected"} />
      <div className="connection-row-text">
        <strong>
          {paired.label}
          {paired.current ? <Badge tone="accent">This device</Badge> : null}
          {paired.access === "read-only" ? <Badge>Read only</Badge> : null}
        </strong>
        <small>{details.join(" · ")}</small>
        {expiring ? <small className="connection-expiring">Signed out {formatExpiresIn(paired.expiresAt!, now).replace("Expires in", "in").replace("Expired", "now")} unless it connects</small> : null}
      </div>
      <button type="button" className="tau-icon-button connection-edit" aria-label={`Settings for ${paired.label}`} {...tooltipProps("Name, access and sign-out")} disabled={busy} onClick={onEdit}>
        <SlidersHorizontal size={15} />
      </button>
      {paired.current ? null : (
        <Button variant="danger" busy={busy} onClick={onRevoke}>{busy ? "Revoking…" : "Revoke"}</Button>
      )}
    </div>
  );
}

function DeviceDialog({ paired, busy, onSave, onCancel }: { paired: UiPairedClient; busy: boolean; onSave(update: UiClientUpdate): void; onCancel(): void }) {
  const [label, setLabel, latestLabel] = useFieldValue(paired.label);
  const [access, setAccess, latestAccess] = useFieldValue<DeviceAccess>(paired.access);
  const [idle, setIdle, latestIdle] = useFieldValue<IdleTimeoutDays>(paired.idleTimeoutDays);
  const submit = () => {
    const name = latestLabel.current;
    if (!name) return;
    onSave({
      ...(name !== paired.label ? { label: name } : {}),
      ...(latestAccess.current !== paired.access ? { access: latestAccess.current } : {}),
      ...(latestIdle.current !== paired.idleTimeoutDays ? { idleTimeoutDays: latestIdle.current } : {}),
    });
  };
  return (
    <Dialog className="confirm-dialog connection-create-dialog" label={`Settings for ${paired.label}`} onClose={onCancel}>
      <h2>{paired.label}</h2>
      <div className="dialog-fields" onKeyDown={submitOnEnter(submit)}>
        <label className="dialog-field">
          <span>Name</span>
          <TextField label="Name" value={label} width="full" disabled={busy} onCommit={(text) => setLabel(text.trim().slice(0, NAME_LIMIT))} />
          {label ? null : <small className="dialog-field-error" role="alert">Give the device a name to save.</small>}
        </label>
        <div className="dialog-field">
          <span>Access</span>
          <AccessChoice value={access} onChange={setAccess} disabled={busy} />
        </div>
        <label className="dialog-field">
          <span>Sign out after</span>
          <Select label="Sign out after" width="full" value={idle === null ? "never" : String(idle)} disabled={busy}
            options={IDLE_TIMEOUT_CHOICES.map((days) => ({ value: days === null ? "never" : String(days), label: idleLabel(days) }))}
            onChange={(next) => setIdle(next === "never" ? null : Number(next) as IdleTimeoutDays)} />
          <small>A change of access applies to its next request. Every use restarts the sign-out clock.</small>
        </label>
      </div>
      <footer>
        <Button onClick={onCancel}>Cancel</Button>
        <span {...tooltipProps(label ? undefined : "Give the device a name first.")}>
          <Button variant="primary" busy={busy} disabled={!label} onClick={submit}>{busy ? "Saving…" : "Save"}</Button>
        </span>
      </footer>
      <DialogClose onClose={onCancel} />
    </Dialog>
  );
}

function OwnerRow({ owner, now }: { owner: UiOwnerConnection; now: number }) {
  const name = owner.profile === "web" || owner.profile === "compact" ? "Browser" : "Tau window";
  const details = [describeDevice(owner.device), owner.address, owner.proxyUser ? `as ${owner.proxyUser}` : undefined, `connected ${formatAgo(owner.since, now)}`, "host token"].filter(Boolean);
  return (
    <div className="connection-row">
      <StatusDot tone="live" label="Connected" />
      <div className="connection-row-text">
        <strong>{name}{owner.current ? <Badge tone="accent">This device</Badge> : null}</strong>
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
          <button type="button" className="tau-icon-button" aria-label="Hide the new link" {...tooltipProps("Hide the new link")} onClick={onDismiss}><X size={14} /></button>
        </div>
        <p>Open it or scan it on the device you want to connect. It works once, {formatExpiresIn(created.link.expiresAt, now).toLowerCase()}, and this is the only time Tau shows it. When the device asks, you allow it here after comparing a code.</p>
        {created.urls.length > 1 ? (
          created.urls.length <= 4
            ? <SegmentedControl label="Address in the link" value={shown?.url} options={created.urls.map((endpoint) => ({ value: endpoint.url, label: endpoint.label }))} onChange={setChosen} />
            : <Select label="Address in the link" width="full" value={shown?.url} options={created.urls.map((endpoint) => ({ value: endpoint.url, label: endpoint.label }))} onChange={setChosen} />
        ) : null}
        {shown ? (
          <div className="connection-link-box">
            <code title={shown.url}>{shown.url}</code>
            <Button onClick={() => onCopy(shown.url, "Pairing link")}>Copy link</Button>
          </div>
        ) : <p>This host listens nowhere another device could reach.</p>}
        <Button variant="ghost" className="connection-copy-code" onClick={() => onCopy(created.code, "Pairing code")}>Copy the code only</Button>
      </div>
      {shown && shown.reachability === "network" ? <PairingQrCode value={shown.url} /> : (
        <p className="connection-qr-missing">No QR code for a loopback address: a device that scans it would dial itself. Copy the link for a browser on this machine.</p>
      )}
    </div>
  );
}

function CreateLinkDialog({ busy, onCreate, onCancel }: { busy: boolean; onCreate(input: { label?: string; lifetimeMs: number; access: DeviceAccess }): void; onCancel(): void }) {
  const [label, setLabel, latestLabel] = useFieldValue("");
  const [lifetime, setLifetime, latestLifetime] = useFieldValue(LINK_LIFETIMES[0]!.ms);
  const [access, setAccess, latestAccess] = useFieldValue<DeviceAccess>("full");
  const submit = () => onCreate({ ...(latestLabel.current ? { label: latestLabel.current } : {}), lifetimeMs: latestLifetime.current, access: latestAccess.current });
  return (
    <Dialog className="confirm-dialog connection-create-dialog" label="Create pairing link" onClose={onCancel}>
      <h2>Create pairing link</h2>
      <p>A one-time link another device opens to ask for a token of its own. You allow it here when it asks. It never sees the host token.</p>
      <div className="dialog-fields" onKeyDown={submitOnEnter(submit)}>
        <label className="dialog-field">
          <span>Client label (optional)</span>
          <TextField label="Client label" value={label} placeholder="e.g. Kitchen iPad" width="full" disabled={busy} onCommit={(text) => setLabel(text.trim().slice(0, NAME_LIMIT))} />
        </label>
        <label className="dialog-field">
          <span>Expires after</span>
          <Select label="Expires after" width="full" value={String(lifetime)} disabled={busy}
            options={LINK_LIFETIMES.map((entry) => ({ value: String(entry.ms), label: entry.label }))}
            onChange={(next) => setLifetime(Number(next))} />
        </label>
        <div className="dialog-field">
          <span>Access</span>
          <AccessChoice value={access} onChange={setAccess} disabled={busy} />
        </div>
      </div>
      <footer>
        <Button onClick={onCancel}>Cancel</Button>
        <Button variant="primary" busy={busy} onClick={submit}>{busy ? "Creating…" : "Create link"}</Button>
      </footer>
      <DialogClose onClose={onCancel} />
    </Dialog>
  );
}
