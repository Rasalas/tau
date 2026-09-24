import { useCallback, useEffect, useRef, useState } from "react";
import type { UiHostService } from "../../shared/connections";
import { CONFIG_DEFAULTS } from "../../shared/config-layers";
import { useHostClient } from "../host-client-context";
import { ConfirmDialog } from "../components/ui/ConfirmDialog";
import { SettingRow, SettingsSection, Switch, useSetting } from "./settings-layout";
import { settingAnchor } from "./settings-search";

type ServiceState =
  | { status: "loading" }
  | { status: "absent" }
  | { status: "error"; message: string }
  | { status: "ready"; service: UiHostService };

type Pending = "install" | "repair" | "uninstall";

const readBoolean = (raw: unknown) => (typeof raw === "boolean" ? raw : undefined);

const WHAT_IT_DOES: Record<NonNullable<UiHostService["manager"]>, string> = {
  launchd: "A LaunchAgent starts Tau’s host when you log in and keeps it running after you quit Tau. It stops when you log out.",
  systemd: "A systemd user unit starts Tau’s host and keeps it running after you quit Tau, at boot when lingering is on.",
  "task-scheduler": "A scheduled task starts Tau’s host when you log in and keeps it running after you quit Tau.",
};

function serviceSummary(service: UiHostService): { tone: "live" | "idle" | "pending"; text: string } {
  if (!service.installed) return { tone: "idle", text: "Not installed" };
  if (service.stale || service.problems.length > 0) return { tone: "pending", text: service.running ? "Running, needs repair" : "Needs repair" };
  if (!service.running) return { tone: "pending", text: "Installed, not running" };
  return { tone: "live", text: service.version ? `Running · Tau ${service.version}` : "Running" };
}

/**
 * Settings → Connections, Background: the host as a service of the machine it
 * runs on, and whether that machine stays awake while turns run. The host
 * answers for its own machine, whichever device asks.
 */
export function HostServiceSection({ onNotify }: { onNotify(message: string): void }) {
  const client = useHostClient();
  const [state, setState] = useState<ServiceState>({ status: "loading" });
  const [confirm, setConfirm] = useState<Pending>();
  const [busy, setBusy] = useState<Pending>();
  const mounted = useRef(true);
  const keepAwake = useSetting<boolean>("hostKeepAwake", { defaultValue: CONFIG_DEFAULTS.hostKeepAwake as boolean, read: readBoolean });

  const load = useCallback(async (): Promise<UiHostService | undefined> => {
    if (!client) return undefined;
    try {
      const service = await client.serviceStatus();
      if (mounted.current) setState({ status: "ready", service });
      return service;
    } catch (error: unknown) {
      const code = (error as { code?: unknown })?.code;
      if (!mounted.current) return undefined;
      if (code === "unknown-method" || code === "unsupported") setState({ status: "absent" });
      else setState({ status: "error", message: error instanceof Error ? error.message : String(error) });
      return undefined;
    }
  }, [client]);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => { mounted.current = false; };
  }, [load]);

  /**
   * Installing hands the host over to the one the service starts, and this
   * connection may drop on the way. The answer that counts is the status
   * once a host answers again, not the call's own.
   */
  const run = async (action: Pending) => {
    if (!client) return;
    setConfirm(undefined);
    setBusy(action);
    let failure: string | undefined;
    try {
      await (action === "uninstall" ? client.uninstallService() : client.installService());
    } catch (error: unknown) {
      failure = error instanceof Error ? error.message : String(error);
    }
    let service: UiHostService | undefined;
    for (const delay of [0, 500, 1_000, 2_000, 3_000, 4_000, 5_000]) {
      await new Promise((resolve) => setTimeout(resolve, delay));
      if (!mounted.current) return;
      service = await load();
      if (service && (action === "uninstall" ? !service.installed : service.installed && service.running)) break;
    }
    if (!mounted.current) return;
    setBusy(undefined);
    if (action === "uninstall") onNotify(service && !service.installed ? "The service is removed" : failure ?? "The service is still installed");
    else if (service?.installed && service.running) onNotify("Tau’s host runs as a service");
    else onNotify(failure ?? "The service is installed but its host did not answer yet; see its log");
  };

  const serviceRow = (() => {
    if (state.status === "loading") return <SettingRow title="Run as a system service" description="Reading the service…" />;
    if (state.status === "absent") return <SettingRow title="Run as a system service" description="This host does not manage a service of its machine." />;
    if (state.status === "error") return <SettingRow title="Run as a system service" description={state.message} />;
    const service = state.service;
    if (!service.supported || !service.manager) return <SettingRow title="Run as a system service" description={service.reason ?? "This machine has no service manager Tau knows."} />;
    const summary = serviceSummary(service);
    const needsRepair = service.installed && (service.stale || service.problems.length > 0 || !service.running);
    return (
      <SettingRow
        id={settingAnchor("Run as a system service")}
        title="Run as a system service"
        description={`${WHAT_IT_DOES[service.manager]} Threads, terminals and paired devices keep working without a window; the preview and computer use still need one on this machine.`}
        status={(
          <div className="host-service-status">
            <span className="host-service-summary">
              <span className={`connection-dot ${summary.tone}`} aria-hidden="true" />
              {summary.text}
            </span>
            {service.problems.map((problem) => (
              <p key={problem.code} className="host-service-problem">
                {problem.message}
                {problem.command ? <code>{problem.command}</code> : null}
              </p>
            ))}
            {service.installed && service.unitPath ? <small>Unit <code>{service.unitPath}</code></small> : null}
            <small>Log <code>{service.logPath}</code></small>
          </div>
        )}
        control={(
          <div className="host-service-actions">
            {needsRepair ? (
              <button type="button" className="chrome-button" disabled={busy !== undefined} onClick={() => setConfirm("repair")}>
                {busy === "repair" ? "Repairing…" : "Repair…"}
              </button>
            ) : null}
            {service.installed ? (
              <button type="button" className="chrome-button danger" disabled={busy !== undefined} onClick={() => setConfirm("uninstall")}>
                {busy === "uninstall" ? "Removing…" : "Uninstall…"}
              </button>
            ) : (
              <button type="button" className="chrome-button accent" disabled={busy !== undefined} onClick={() => setConfirm("install")}>
                {busy === "install" ? "Installing…" : "Install…"}
              </button>
            )}
          </div>
        )}
      />
    );
  })();

  return (
    <SettingsSection title="Background">
      {serviceRow}
      <SettingRow
        id={settingAnchor("Keep this machine awake while turns run")}
        title="Keep this machine awake while turns run"
        description="Tau holds off sleep while any thread works, so the turn finishes and other devices can still reach this machine. The display may still turn off."
        setting={keepAwake}
        control={<Switch label="Keep this machine awake while turns run" checked={keepAwake.value} disabled={!keepAwake.writable} onChange={keepAwake.set} />}
      />
      {confirm === "install" || confirm === "repair" ? (
        <ConfirmDialog
          title={confirm === "install" ? "Run Tau’s host as a service?" : "Repair the service?"}
          message="Tau’s host moves into the service. Turns running now stop for a moment and continue if “Continue threads after restarts” is on; this window reconnects by itself."
          confirmLabel={confirm === "install" ? "Install" : "Repair"}
          onCancel={() => setConfirm(undefined)}
          onConfirm={() => void run(confirm)}
        />
      ) : null}
      {confirm === "uninstall" ? (
        <ConfirmDialog
          title="Remove the service?"
          message="The host stops and no longer starts at login. Running turns stop; this window starts a host of its own again."
          confirmLabel="Remove Service"
          destructive
          onCancel={() => setConfirm(undefined)}
          onConfirm={() => void run("uninstall")}
        />
      ) : null}
    </SettingsSection>
  );
}
