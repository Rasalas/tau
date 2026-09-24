import { useCallback, useEffect, useState, type ComponentType, type ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import {
  ConfirmDialog,
  Dialog,
  SettingRow,
  SettingsSection,
  Skeleton,
  errorMessage,
  tooltipProps,
  useWorkbenchShell,
  type HostExtensionClient,
  type SettingsSectionProps,
} from "tau";
import {
  ADMIN_DNS_URL,
  ADMIN_MACHINES_URL,
  DEFAULT_HTTPS_PORT,
  DOWNLOAD_URL,
  HTTPS_DOCS_URL,
  serveUrl,
  type TailscaleCommands,
  type TailscaleView,
} from "./protocol.js";

type Api = <K extends keyof TailscaleCommands>(command: K, input?: TailscaleCommands[K]["input"]) => Promise<TailscaleCommands[K]["output"]>;

/** Serve's second usual HTTPS port, offered when something else holds 443. */
const ALTERNATE_PORT = 8443;

function useOpenExternal(): (url: string) => void {
  let actions: ReturnType<typeof useWorkbenchShell>["actions"] | undefined;
  try {
    actions = useWorkbenchShell().actions;
  } catch {
    actions = undefined;
  }
  return (url) => { if (actions) actions.openExternal(url); else window.open(url, "_blank", "noopener"); };
}

function Switch({ on, disabled, onChange }: { on: boolean; disabled: boolean; onChange(on: boolean): void }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label="Tailscale HTTPS" className={`switch ${on ? "on" : ""}`} disabled={disabled} onClick={() => onChange(!on)}>
      <i />
    </button>
  );
}

/** What another program has Serve forward on a port, if `/` is among it. */
function takenBy(view: TailscaleView, port: number): string | undefined {
  return view.serve.others.find((other) => other.httpsPort === port && (other.path === "/" || other.path === ""))?.target;
}

function describe(view: TailscaleView, open: (url: string) => void): { description: ReactNode; action?: ReactNode } {
  const link = (label: string, url: string) => <button type="button" className="chrome-button" onClick={() => open(url)}>{label}</button>;
  switch (view.state) {
    case "no-host-network": return { description: "This host opens no listeners of its own, so Tailscale has nothing to forward to." };
    case "not-installed": return { description: "Install Tailscale on this machine and sign in to reach Tau from your tailnet over HTTPS.", action: link("Get Tailscale", DOWNLOAD_URL) };
    case "needs-login": return { description: "Tailscale is signed out on this machine. Sign in, then check again." };
    case "not-running": return { description: `Tailscale is not connected on this machine${view.backendState ? ` (${view.backendState})` : ""}. Start it, then check again.` };
    default: break;
  }
  if (view.serve.on && view.serve.url) {
    return {
      description: <>Devices in your tailnet open Tau at <code>{view.serve.url}</code> with a certificate their browser trusts. A device still needs a pairing link.</>,
    };
  }
  if (!view.magicDns || !view.dnsName) return { description: "MagicDNS is off in your tailnet. Turn it on in the admin console’s DNS page, then check again.", action: link("DNS Settings", ADMIN_DNS_URL) };
  if (!view.https) {
    return {
      description: <>HTTPS certificates are off in your tailnet. Turn them on in the admin console’s DNS page, then check again. Each certificate puts this machine’s name in a public log.</>,
      action: link("DNS Settings", ADMIN_DNS_URL),
    };
  }
  return { description: <>Let devices in your tailnet open Tau at <code>{serveUrl(view.dnsName, DEFAULT_HTTPS_PORT)}</code> with a certificate their browser trusts, through Tailscale Serve.</> };
}

/**
 * Settings → Connections → Tailscale, after T3 Code's "Tailscale HTTPS" row:
 * one switch that asks first, a consent step that names what becomes public,
 * and the machine name with a way to rename it.
 */
export function createTailscaleSection(host: HostExtensionClient): ComponentType<SettingsSectionProps> {
  const api: Api = (command, input) => host.invoke(command, input) as never;
  return function TailscaleSection({ onNotify, onChanged }) {
    const [view, setView] = useState<TailscaleView>();
    const [failed, setFailed] = useState<string>();
    const [busy, setBusy] = useState(false);
    const [asking, setAsking] = useState<"on" | "off">();
    const open = useOpenExternal();

    const look = useCallback(async () => {
      setBusy(true);
      try {
        setView(await api("status"));
        setFailed(undefined);
      } catch (error: unknown) {
        setFailed(errorMessage(error));
      } finally {
        setBusy(false);
      }
    }, []);
    useEffect(() => { void look(); }, [look]);

    const change = async (run: () => Promise<TailscaleView>, done: (next: TailscaleView) => string): Promise<boolean> => {
      setBusy(true);
      try {
        const next = await run();
        setView(next);
        onNotify(done(next));
        onChanged();
        return true;
      } catch (error: unknown) {
        onNotify(errorMessage(error));
        return false;
      } finally {
        setBusy(false);
      }
    };

    const recheck = (
      <button type="button" className="tailscale-recheck" aria-label="Check Tailscale again" {...tooltipProps("Check Tailscale again")} disabled={busy} onClick={() => void look()}>
        <RefreshCw size={13} />
      </button>
    );
    if (!view) {
      return (
        <SettingsSection title="Tailscale" headerAction={recheck}>
          {failed ? <SettingRow title="Tailscale HTTPS" description={`Tau could not ask Tailscale: ${failed}`} /> : <div className="tailscale-loading" aria-busy="true"><Skeleton shape="block" /></div>}
        </SettingsSection>
      );
    }

    const { description, action } = describe(view, open);
    const ready = view.state === "running" && view.magicDns && view.https && Boolean(view.dnsName);
    const canSwitch = view.serve.on || ready;
    return (
      <SettingsSection title="Tailscale" headerAction={recheck}>
        {view.notice ? <p className="tailscale-notice" role="status">{view.notice}</p> : null}
        <SettingRow
          title="Tailscale HTTPS"
          description={description}
          status={view.serve.on ? (
            <>
              Tailscale Serve forwards it to Tau on <code>http://127.0.0.1:{view.proxyPort}</code>, and keeps doing so after Tau quits; turn this off to remove it.
              {view.proxyListening ? null : <p className="tailscale-warning-line">Tau’s proxy listener is not open, so devices get an error. Settings above say why.</p>}
            </>
          ) : undefined}
          control={canSwitch ? <Switch on={view.serve.on} disabled={busy} onChange={(on) => setAsking(on ? "on" : "off")} /> : action}
        />
        {view.state === "running" && view.dnsName ? (
          <SettingRow
            title="Machine name"
            description={view.serve.on
              ? "Part of the address. Its certificate is in the public Certificate Transparency logs."
              : "Part of the address. Turning Tailscale HTTPS on publishes it in the Certificate Transparency logs."}
            status={<code className="tailscale-name">{view.dnsName}</code>}
            control={<button type="button" className="chrome-button" onClick={() => open(ADMIN_MACHINES_URL)}>Rename…</button>}
          />
        ) : null}
        {asking === "on" && view.dnsName ? (
          <ConsentDialog
            view={view}
            dnsName={view.dnsName}
            busy={busy}
            onOpen={open}
            onCancel={() => setAsking(undefined)}
            onConfirm={(httpsPort) => void change(() => api("serve-on", { httpsPort, name: view.dnsName! }), (next) => `Tailscale HTTPS is on: ${next.serve.url ?? ""}`)
              .then((ok) => { if (ok) setAsking(undefined); })}
          />
        ) : null}
        {asking === "off" ? (
          <ConfirmDialog
            title="Turn off Tailscale HTTPS?"
            message={<>Tau removes its path from Tailscale Serve. Devices that use <code>{view.serve.url}</code> disconnect now. The certificate stays in the public logs.</>}
            confirmLabel="Turn Off"
            destructive
            onCancel={() => setAsking(undefined)}
            onConfirm={() => { setAsking(undefined); void change(() => api("serve-off"), () => "Tailscale HTTPS is off"); }}
          />
        ) : null}
      </SettingsSection>
    );
  };
}

function ConsentDialog({ view, dnsName, busy, onOpen, onCancel, onConfirm }: {
  view: TailscaleView;
  dnsName: string;
  busy: boolean;
  onOpen(url: string): void;
  onCancel(): void;
  onConfirm(httpsPort: number): void;
}) {
  const [port, setPort] = useState(() => String(takenBy(view, DEFAULT_HTTPS_PORT) && !takenBy(view, ALTERNATE_PORT) ? ALTERNATE_PORT : DEFAULT_HTTPS_PORT));
  const [agreed, setAgreed] = useState(false);
  const number = Number(port);
  const valid = /^\d+$/u.test(port) && number >= 1 && number <= 65535;
  const taken = valid ? takenBy(view, number) : undefined;
  return (
    <Dialog className="confirm-dialog tailscale-consent" label="Set up Tailscale HTTPS" onClose={onCancel}>
      <h2>Set up Tailscale HTTPS?</h2>
      <p>
        Tau asks Tailscale Serve to answer at the address below in your tailnet and forward it to Tau on <code>127.0.0.1:{view.proxyPort}</code>.
        Devices in your tailnet then open Tau without a certificate warning. They still need a pairing link. Paired with Full access a device can do what you can here; Read only, it can only look. Who may connect is changed only on this machine.
      </p>
      <section className="tailscale-public" aria-label="What becomes public">
        <strong>This machine’s name becomes public.</strong>
        <p>
          Tailscale gets the certificate from Let’s Encrypt, and every such certificate is written to the public Certificate Transparency logs.
          Anyone can look up <code>{dnsName}</code> there, now and for years; the entry cannot be removed.
        </p>
        <p>If the name says more than you want (your name, your employer, a project), rename the machine in the Tailscale admin console first, then check again here.</p>
        <div className="tailscale-public-links">
          <button type="button" className="chrome-button" onClick={() => onOpen(ADMIN_MACHINES_URL)}>Rename Machine…</button>
          <button type="button" className="chrome-button" onClick={() => onOpen(HTTPS_DOCS_URL)}>About Certificates</button>
        </div>
      </section>
      <label className="connection-field">
        <span>HTTPS port</span>
        <input
          className="settings-input narrow"
          inputMode="numeric"
          aria-invalid={!valid || taken !== undefined}
          value={port}
          disabled={busy}
          onChange={(event) => setPort(event.target.value.replace(/\D/gu, "").slice(0, 5))}
        />
      </label>
      {!valid ? <p className="tailscale-warning-line">Enter a port from 1 to 65535.</p> : null}
      {taken ? <p className="tailscale-warning-line">Serve already forwards port {number} to {taken}. Pick another port.</p> : null}
      <p className="tailscale-address">Address: <code>{valid ? serveUrl(dnsName, number) : "—"}</code></p>
      <label className="tailscale-agree">
        <input type="checkbox" checked={agreed} disabled={busy} onChange={(event) => setAgreed(event.target.checked)} />
        <span>I understand that <code>{dnsName}</code> will be published.</span>
      </label>
      <footer>
        <button type="button" className="text-button" onClick={onCancel}>Cancel</button>
        <button type="button" className="primary" disabled={busy || !agreed || !valid || taken !== undefined} onClick={() => onConfirm(number)}>
          {busy ? "Setting Up…" : "Set Up"}
        </button>
      </footer>
    </Dialog>
  );
}
