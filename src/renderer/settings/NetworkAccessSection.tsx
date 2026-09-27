import { useState } from "react";
import type { UiNetworkAccess, UiNetworkAnnouncement, UiNetworkSettingsInput } from "../../shared/connections";
import { ConfirmDialog } from "../components/ui/ConfirmDialog";
import { Dialog } from "../components/ui/Dialog";
import { DialogClose, submitOnEnter, useFieldValue } from "../pairing/dialog-parts";
import { Button, NumberField, TextField } from "./controls";
import { SettingRow, SettingsSection, Switch } from "./settings-layout";
import { settingAnchor } from "./settings-search";

type Switchable = "lan" | "tailscale";

const QUESTIONS: Record<Switchable, { on: { title: string; message: string }; off: { title: string; message: string } }> = {
  lan: {
    on: {
      title: "Let devices on your network connect?",
      message: "Tau listens on every network interface of this machine, over TLS only, and announces itself with Bonjour. A device still needs your approval here. Paired with Full access it can run agents, open terminals and read files; Read only, it can only look. Who may connect is changed only on this machine.",
    },
    off: {
      title: "Stop listening on the local network?",
      message: "Devices connected over the local network disconnect now. Tailscale, if it is on, keeps working.",
    },
  },
  tailscale: {
    on: {
      title: "Let devices in your tailnet connect?",
      message: "Tau listens on this machine’s Tailscale addresses, over TLS only, and on a loopback port a proxy such as tailscale serve can forward to. A device still needs a pairing link from this page.",
    },
    off: {
      title: "Stop listening on Tailscale?",
      message: "Devices connected over Tailscale disconnect now. The local network, if it is on, keeps working.",
    },
  },
};

const MIN_PORT = 1024;
const MAX_PORT = 65535;


/** What the announcement row says under its switch. */
function announcementText(announcement: UiNetworkAnnouncement | undefined, lanListening: boolean): string {
  if (!lanListening) return "Once Tau listens on the local network.";
  if (!announcement) return "Starting…";
  switch (announcement.state) {
    case "announced": return `Devices here see this machine as “${announcement.name}”.`;
    case "starting": return "Waiting for the system; macOS may ask about local network access.";
    case "failed": return `${announcement.detail ?? "The announcement stopped."} Tau tries again every minute.`;
    case "unavailable": return announcement.detail ?? "No Bonjour responder on this system.";
  }
}

function formatDate(iso: string): string {
  const time = Date.parse(iso);
  return Number.isFinite(time) ? new Date(time).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : iso;
}

/**
 * Settings → Connections → Network access, after T3 Code's "Network access"
 * and "Tailscale HTTPS" rows. Tau's listeners open and close in the running
 * host, so a switch asks once and applies at once; nothing restarts.
 */
export function NetworkAccessSection({ network, busy, onChange, onReload }: {
  network: UiNetworkAccess;
  busy: boolean;
  onChange(input: UiNetworkSettingsInput, done: string): Promise<boolean>;
  onReload(): void;
}) {
  const { settings } = network;
  const [asking, setAsking] = useState<{ key: Switchable; on: boolean }>();
  const [ownCertificate, setOwnCertificate] = useState(false);
  // A refused port puts the field back to the one in use.
  const [portAttempt, setPortAttempt] = useState(0);

  const lanListening = network.listeners.some((listener) => listener.kind === "network" && (listener.host === "::" || listener.host === "0.0.0.0"));
  const tailscaleListening = network.listeners.some((listener) => listener.kind === "network" && listener.host !== "::" && listener.host !== "0.0.0.0");
  const proxy = network.listeners.find((listener) => listener.kind === "proxy");
  const listening = settings.lan || settings.tailscale;
  const question = asking ? QUESTIONS[asking.key][asking.on ? "on" : "off"] : undefined;

  return (
    <SettingsSection title="Network access">
      {network.problems.length ? (
        <SettingRow
          title="Needs attention"
          status={<ul className="network-problems" role="status">{network.problems.map((problem) => <li key={problem}>{problem}</li>)}</ul>}
        />
      ) : null}
      <SettingRow
        id={settingAnchor("Local network")}
        title="Local network"
        description={settings.lan
          ? `Devices on the same network reach Tau over HTTPS on port ${settings.port}.${lanListening ? "" : " Not listening yet."}`
          : "Only this machine can connect."}
        control={<Switch label="Local network" checked={settings.lan} disabled={busy} onChange={(on) => setAsking({ key: "lan", on })} />}
      />
      {settings.lan ? (
        <SettingRow
          id={settingAnchor("Announce on this network")}
          title="Announce on this network"
          description={settings.announce
            ? "Lets devices here find Tau. It shares only the host id and certificate fingerprint; a device still needs your approval."
            : "Only a pairing link or QR code leads here."}
          status={settings.announce ? announcementText(network.announcement, lanListening) : undefined}
          control={<Switch label="Announce on this network" checked={settings.announce} disabled={busy} onChange={(on) => void onChange({ announce: on }, on ? "Announcing Tau on this network" : "No longer announced on this network")} />}
        />
      ) : null}
      <SettingRow
        id={settingAnchor("Tailscale")}
        title="Tailscale"
        description={settings.tailscale
          ? tailscaleListening || settings.lan
            ? `Devices in your tailnet reach Tau at its Tailscale address and MagicDNS name on port ${settings.port}.`
            : "Waiting for Tailscale: Tau listens on it once this machine has a Tailscale address."
          : network.tailscaleUp
            ? "Tailscale runs on this machine. Turn this on to let your tailnet’s devices connect."
            : "Tailscale has no address on this machine."}
        status={settings.tailscale && proxy ? <>A proxy on this machine, such as <code>tailscale serve</code>, forwards to <code>http://127.0.0.1:{proxy.port}</code>; everything through it counts as a remote device.</> : undefined}
        control={<Switch label="Tailscale" checked={settings.tailscale} disabled={busy} onChange={(on) => setAsking({ key: "tailscale", on })} />}
      />
      <SettingRow
        id={settingAnchor("Port")}
        title="Port"
        description="Fixed, so a paired device finds Tau again after a restart."
        help={`From ${MIN_PORT} to ${MAX_PORT}. The proxy listener uses ${settings.proxyPort}, so this one cannot. A listener that is on moves to the new port at once.`}
        control={(
          <NumberField
            key={portAttempt}
            label="Port"
            value={settings.port}
            min={MIN_PORT}
            max={MAX_PORT}
            integer
            disabled={busy}
            validate={(port) => (port === settings.proxyPort ? `${port} is the proxy listener’s port. Pick another.` : undefined)}
            onCommit={(port) => void onChange({ port }, listening ? `Tau now listens on port ${port}` : `Tau will listen on port ${port}`).then((ok) => { if (!ok) setPortAttempt((count) => count + 1); })}
          />
        )}
      />
      <SettingRow
        id={settingAnchor("Certificate")}
        title="Certificate"
        description={network.certificate
          ? network.certificate.source === "supplied"
            ? <>Your own, from <code>{network.certificate.certPath}</code>, valid until {formatDate(network.certificate.validTo)}. Tau reads it again when the file changes.</>
            : <>Self-signed, valid until {formatDate(network.certificate.validTo)}. A browser warns about it; trust it only if the browser shows this fingerprint.</>
          : settings.certificate
            ? <>Your own, from <code>{settings.certificate.certPath}</code>, once a listener is on.</>
            : "Self-signed, made when a listener first needs it."}
        status={network.certificate ? (
          <>
            <code className="connection-fingerprint">{network.certificate.fingerprint}</code>
            {network.certificate.warnings.map((warning) => <p key={warning} className="network-warning">{warning}</p>)}
          </>
        ) : undefined}
        control={(
          <div className="network-certificate-actions">
            {network.certificate ? <Button disabled={busy} onClick={onReload}>Read again</Button> : null}
            {settings.certificate
              ? <Button disabled={busy} onClick={() => void onChange({ certificate: null }, "Back to the self-signed certificate")}>Use self-signed</Button>
              : <Button disabled={busy} onClick={() => setOwnCertificate(true)}>Use your own…</Button>}
          </div>
        )}
      />
      {asking && question ? (
        <ConfirmDialog
          title={question.title}
          message={question.message}
          confirmLabel={asking.on ? "Turn on" : "Turn off"}
          destructive={!asking.on}
          onCancel={() => setAsking(undefined)}
          onConfirm={() => {
            const { key, on } = asking;
            setAsking(undefined);
            void onChange({ [key]: on }, `${key === "lan" ? "Local network" : "Tailscale"} ${on ? "on" : "off"}`);
          }}
        />
      ) : null}
      {ownCertificate ? (
        <OwnCertificateDialog
          busy={busy}
          onCancel={() => setOwnCertificate(false)}
          onUse={(certificate) => void onChange({ certificate }, listening ? "Tau now serves your certificate" : "Tau will serve your certificate once a listener is on").then((ok) => { if (ok) setOwnCertificate(false); })}
        />
      ) : null}
    </SettingsSection>
  );
}

function OwnCertificateDialog({ busy, onUse, onCancel }: {
  busy: boolean;
  onUse(certificate: { certPath: string; keyPath: string }): void;
  onCancel(): void;
}) {
  const [certPath, setCertPath, latestCert] = useFieldValue("");
  const [keyPath, setKeyPath, latestKey] = useFieldValue("");
  const [missing, setMissing] = useState(false);
  const submit = () => {
    const cert = latestCert.current.trim();
    const key = latestKey.current.trim();
    if (!cert || !key) { setMissing(true); return; }
    setMissing(false);
    onUse({ certPath: cert, keyPath: key });
  };
  return (
    <Dialog className="confirm-dialog connection-create-dialog" label="Use your own certificate" onClose={onCancel}>
      <h2>Use your own certificate</h2>
      <p>A PEM certificate and its key, for example from <code>tailscale cert</code>. Tau reads them again whenever the files change, so a renewal needs no restart.</p>
      <div className="dialog-fields" onKeyDown={submitOnEnter(submit)}>
        <label className="dialog-field">
          <span>Certificate file</span>
          <TextField label="Certificate file" value={certPath} placeholder="/path/to/machine.crt" width="full" mono disabled={busy} onCommit={setCertPath} />
        </label>
        <label className="dialog-field">
          <span>Key file</span>
          <TextField label="Key file" value={keyPath} placeholder="/path/to/machine.key" width="full" mono disabled={busy} onCommit={setKeyPath} />
        </label>
      </div>
      {missing && (!certPath.trim() || !keyPath.trim()) ? <p className="dialog-error" role="alert">Enter the path of both files.</p> : null}
      <footer>
        <Button onClick={onCancel}>Cancel</Button>
        <Button variant="primary" busy={busy} onClick={submit}>{busy ? "Checking…" : "Use certificate"}</Button>
      </footer>
      <DialogClose onClose={onCancel} />
    </Dialog>
  );
}
