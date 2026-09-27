import { useCallback, useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import { ExternalLink, RefreshCw, X } from "lucide-react";
import {
  Button,
  ConfirmDialog,
  Dialog,
  NumberField,
  SettingRow,
  SettingsSection,
  SettingsState,
  Switch,
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

/** What another program has Serve forward on a port, if `/` is among it. */
function takenBy(view: TailscaleView, port: number): string | undefined {
  return view.serve.others.find((other) => other.httpsPort === port && (other.path === "/" || other.path === ""))?.target;
}

function describe(view: TailscaleView, open: (url: string) => void): { description: ReactNode; action?: ReactNode } {
  const link = (label: string, url: string) => <Button icon={<ExternalLink size={13} />} onClick={() => open(url)}>{label}</Button>;
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
  if (!view.magicDns || !view.dnsName) return { description: "MagicDNS is off in your tailnet. Turn it on in the admin console’s DNS page, then check again.", action: link("Open DNS settings", ADMIN_DNS_URL) };
  if (!view.https) {
    return {
      description: <>HTTPS certificates are off in your tailnet. Turn them on in the admin console’s DNS page, then check again. Each certificate puts this machine’s name in a public log.</>,
      action: link("Open DNS settings", ADMIN_DNS_URL),
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
      <Button variant="ghost" icon={<RefreshCw size={13} />} busy={busy} onClick={() => void look()}>Check again</Button>
    );
    if (!view) {
      return (
        <SettingsSection title="Tailscale" headerAction={recheck}>
          {failed
            ? <SettingsState kind="error" title="Tau could not ask Tailscale" description={failed} onRetry={() => void look()} />
            : <SettingsState kind="loading" rows={1} title="Asking Tailscale" />}
        </SettingsSection>
      );
    }

    const { description, action } = describe(view, open);
    const ready = view.state === "running" && view.magicDns && view.https && Boolean(view.dnsName);
    const canSwitch = view.serve.on || ready;
    return (
      <SettingsSection title="Tailscale" headerAction={recheck}>
        <SettingRow
          id="setting-tailscale-https"
          title="Tailscale HTTPS"
          description={description}
          status={view.serve.on || view.notice ? (
            <>
              {view.notice ? <p className="tailscale-notice" role="status">{view.notice}</p> : null}
              {view.serve.on ? <>
                Tailscale Serve forwards it to Tau on <code>http://127.0.0.1:{view.proxyPort}</code>, and keeps doing so after Tau quits; turn this off to remove it.
                {view.proxyListening ? null : <p className="tailscale-warning-line">Tau’s proxy listener is not open, so devices get an error. Settings above say why.</p>}
              </> : null}
            </>
          ) : undefined}
          control={canSwitch ? <Switch label="Tailscale HTTPS" checked={view.serve.on} disabled={busy} onChange={(on) => setAsking(on ? "on" : "off")} /> : action}
        />
        {view.state === "running" && view.dnsName ? (
          <SettingRow
            id="setting-tailscale-machine-name"
            title="Machine name"
            description={view.serve.on
              ? "Part of the address. Its certificate is in the public Certificate Transparency logs."
              : "Part of the address. Turning Tailscale HTTPS on publishes it in the Certificate Transparency logs."}
            status={<code className="tailscale-name">{view.dnsName}</code>}
            control={<Button icon={<ExternalLink size={13} />} onClick={() => open(ADMIN_MACHINES_URL)}>Rename in Tailscale</Button>}
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
            confirmLabel="Turn off"
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
  const [port, setPort] = useState(() => (takenBy(view, DEFAULT_HTTPS_PORT) && !takenBy(view, ALTERNATE_PORT) ? ALTERNATE_PORT : DEFAULT_HTTPS_PORT));
  const [agreed, setAgreed] = useState(false);
  const field = useRef<HTMLSpanElement>(null);
  const taken = takenBy(view, port);
  const submit = () => {
    // A refused draft stays in the field with its reason; the port it shows is not the one to set up.
    if (field.current?.querySelector("input")?.value.trim() !== String(port)) return;
    if (agreed && !taken) onConfirm(port);
  };
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
          <Button icon={<ExternalLink size={13} />} onClick={() => onOpen(ADMIN_MACHINES_URL)}>Rename in Tailscale</Button>
          <Button variant="ghost" icon={<ExternalLink size={13} />} onClick={() => onOpen(HTTPS_DOCS_URL)}>About certificates</Button>
        </div>
      </section>
      <label className="tailscale-field">
        <span>HTTPS port</span>
        <span ref={field}>
          <NumberField
            label="HTTPS port"
            value={port}
            min={1}
            max={65535}
            integer
            disabled={busy}
            validate={(next) => {
              const holder = takenBy(view, next);
              return holder ? `Serve already forwards port ${next} to ${holder}. Pick another port.` : undefined;
            }}
            onCommit={setPort}
          />
        </span>
      </label>
      {taken ? <p className="tailscale-warning-line">Serve already forwards port {port} to {taken}. Pick another port.</p> : null}
      <p className="tailscale-address">Address: <code>{serveUrl(dnsName, port)}</code></p>
      <label className="tailscale-agree">
        <Switch role="checkbox" label={`I understand that ${dnsName} will be published`} checked={agreed} disabled={busy} onChange={setAgreed} />
        <span aria-hidden="true">I understand that <code>{dnsName}</code> will be published.</span>
      </label>
      <footer>
        <Button onClick={onCancel}>Cancel</Button>
        <span {...tooltipProps(agreed ? undefined : "Confirm that the name will be published first.")}>
          <Button variant="primary" busy={busy} disabled={!agreed || taken !== undefined} onClick={submit}>
            {busy ? "Setting up…" : "Set up"}
          </Button>
        </span>
      </footer>
      <Button variant="ghost" className="tailscale-dialog-close" icon={<X size={16} />} aria-label="Close" {...tooltipProps("Close")} onClick={onCancel} />
    </Dialog>
  );
}
