import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "../../workbench/error-message";
import type { UiHostService } from "../../shared/connections";
import { CONFIG_DEFAULTS } from "../../shared/config-layers";
import { useHostClient } from "../host-client-context";
import { ConfirmDialog } from "../components/ui/ConfirmDialog";
import { Badge, Button, SettingsState, ValueList, type ValueListItem } from "./controls";
import { SettingRow, SettingsSection, Switch, useSetting } from "./settings-layout";
import { settingAnchor } from "./settings-search";

type ServiceState =
  | { status: "loading" }
  | { status: "absent" }
  | { status: "error"; message: string }
  | { status: "ready"; service: UiHostService };

type Pending = "install" | "repair" | "uninstall" | "display-add" | "display-remove" | "sandbox";

/** `linux-sandbox.ts`: the host adds an AppArmor profile through its machine's password dialog. */
const SANDBOX_PROBLEM = "chrome-sandbox";

const readBoolean = (raw: unknown) => (typeof raw === "boolean" ? raw : undefined);

const WHAT_IT_DOES: Record<NonNullable<UiHostService["manager"]>, string> = {
  launchd: "A LaunchAgent starts Tau’s host when you log in and keeps it running after you quit Tau. It stops when you log out.",
  systemd: "A systemd user unit starts Tau’s host and keeps it running after you quit Tau, at boot when lingering is on.",
  "task-scheduler": "A scheduled task starts Tau’s host when you log in and keeps it running after you quit Tau.",
};

function serviceSummary(service: UiHostService): { tone: "neutral" | "success" | "warn"; text: string } {
  if (!service.installed) return { tone: "neutral", text: "Not installed" };
  if (service.stale || service.problems.length > 0) return { tone: "warn", text: service.running ? "Running, needs repair" : "Needs repair" };
  if (!service.running) return { tone: "warn", text: "Installed, not running" };
  return { tone: "success", text: service.version ? `Running · Tau ${service.version}` : "Running" };
}

const SERVICE_TITLE = "Run as a system service";

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
      else setState({ status: "error", message: errorMessage(error) });
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
    const display = action === "display-add" ? true : action === "display-remove" ? false : undefined;
    try {
      if (action === "sandbox") await client.allowServiceSandbox();
      else await (action === "uninstall" ? client.uninstallService() : client.installService(display === undefined ? undefined : { display }));
    } catch (error: unknown) {
      failure = errorMessage(error);
    }
    if (action === "sandbox") {
      const service = await load();
      if (!mounted.current) return;
      setBusy(undefined);
      onNotify(failure ?? (service?.problems.some((problem) => problem.code === SANDBOX_PROBLEM) ? "The profile did not take effect; see the service log" : "The window on the invisible display can start now"));
      return;
    }
    const settled = (service: UiHostService) => {
      if (action === "uninstall") return !service.installed;
      return service.installed && service.running && (display === undefined || service.display?.installed === display);
    };
    let service: UiHostService | undefined;
    for (const delay of [0, 500, 1_000, 2_000, 3_000, 4_000, 5_000]) {
      await new Promise((resolve) => setTimeout(resolve, delay));
      if (!mounted.current) return;
      service = await load();
      if (service && settled(service)) break;
    }
    if (!mounted.current) return;
    setBusy(undefined);
    if (display !== undefined) {
      if (service && settled(service)) onNotify(display ? `The invisible display ${service.display?.display ?? ""} is on`.trimEnd() : "The invisible display is removed");
      else onNotify(failure ?? "The display did not change; see the service log");
      return;
    }
    if (action === "uninstall") onNotify(service && !service.installed ? "The service is removed" : failure ?? "The service is still installed");
    else if (service?.installed && service.running) onNotify("Tau’s host runs as a service");
    else onNotify(failure ?? "The service is installed but its host did not answer yet; see its log");
  };

  const serviceRow = (() => {
    const id = settingAnchor(SERVICE_TITLE);
    if (state.status === "loading") return <SettingsState kind="loading" rows={1} title="Reading the service" />;
    if (state.status === "error") {
      return <SettingsState kind="error" title="The service did not answer" description={state.message} onRetry={() => { setState({ status: "loading" }); void load(); }} />;
    }
    if (state.status === "absent") return <SettingRow id={id} title={SERVICE_TITLE} description="This host does not manage a service of its machine." />;
    const service = state.service;
    if (!service.supported || !service.manager) return <SettingRow id={id} title={SERVICE_TITLE} description={service.reason ?? "This machine has no service manager Tau knows."} />;
    const summary = serviceSummary(service);
    const needsRepair = service.installed && (service.stale || service.problems.length > 0 || !service.running);
    const files: ValueListItem[] = [
      ...(service.installed && service.unitPath ? [{ label: "Unit", value: service.unitPath, mono: true, copy: service.unitPath }] : []),
      { label: "Log", value: service.logPath, mono: true, copy: service.logPath },
    ];
    return (
      <SettingRow
        id={id}
        title={SERVICE_TITLE}
        description={WHAT_IT_DOES[service.manager]}
        help="Threads, terminals and paired devices keep working without a window; the preview and computer use still need one on this machine."
        status={(
          <div className="host-service-status">
            <Badge tone={summary.tone} dot>{summary.text}</Badge>
            {service.problems.map((problem) => (
              <div key={problem.code} className="host-service-problem">
                <p>{problem.message}</p>
                {problem.code === SANDBOX_PROBLEM ? (
                  problem.command ? (
                    <Button busy={busy === "sandbox"} disabled={busy !== undefined} onClick={() => void run("sandbox")}>
                      {busy === "sandbox" ? "Waiting for the password…" : "Add AppArmor profile…"}
                    </Button>
                  ) : null
                ) : problem.command ? <code>{problem.command}</code> : null}
              </div>
            ))}
            <ValueList label="Service files" items={files} />
          </div>
        )}
        control={(
          <div className="host-service-actions">
            {needsRepair ? (
              <Button busy={busy === "repair"} disabled={busy !== undefined} onClick={() => setConfirm("repair")}>
                {busy === "repair" ? "Repairing…" : "Repair…"}
              </Button>
            ) : null}
            {service.installed ? (
              <Button variant="danger" busy={busy === "uninstall"} disabled={busy !== undefined} onClick={() => setConfirm("uninstall")}>
                {busy === "uninstall" ? "Removing…" : "Uninstall…"}
              </Button>
            ) : (
              <Button busy={busy === "install"} disabled={busy !== undefined} onClick={() => setConfirm("install")}>
                {busy === "install" ? "Installing…" : "Install…"}
              </Button>
            )}
          </div>
        )}
      />
    );
  })();

  const displayRow = (() => {
    if (state.status !== "ready") return null;
    const { service } = state;
    const display = service.display;
    // Only a systemd service can have one; elsewhere the reason is in `tau service install --display`.
    if (!service.installed || service.manager !== "systemd" || !display?.supported) return null;
    const text = display.installed
      ? `${display.display ?? "Display"} · window ${display.windowRunning ? "running" : "starts when needed"}`
      : "Off";
    const tone = !display.installed ? "neutral" : display.xvfbRunning ? "success" : "warn";
    return (
      <SettingRow
        id={settingAnchor("Invisible display")}
        title="Invisible display"
        description="A screen nobody sees (Xvfb) where agents’ GUI apps, headed browsers and the preview run while no one has Tau open on this machine."
        help={`A Tau window on it gives threads the preview. The window starts when a thread needs it and stops after ${display.idleMinutes} minutes without use.`}
        status={(
          <div className="host-service-status">
            <Badge tone={tone} dot>{text}</Badge>
            {display.installed && !display.xvfbRunning ? <p className="host-service-problem">Xvfb is not running. Repair the service, or see its log.</p> : null}
          </div>
        )}
        control={display.installed ? (
          <Button variant="danger" busy={busy === "display-remove"} disabled={busy !== undefined} onClick={() => setConfirm("display-remove")}>
            {busy === "display-remove" ? "Removing…" : "Remove…"}
          </Button>
        ) : (
          <Button busy={busy === "display-add"} disabled={busy !== undefined} onClick={() => setConfirm("display-add")}>
            {busy === "display-add" ? "Adding…" : "Add…"}
          </Button>
        )}
      />
    );
  })();

  return (
    <SettingsSection title="Background">
      {serviceRow}
      {displayRow}
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
      {confirm === "display-add" || confirm === "display-remove" ? (
        <ConfirmDialog
          title={confirm === "display-add" ? "Add an invisible display?" : "Remove the invisible display?"}
          message={confirm === "display-add"
            ? "Tau’s host restarts with the display. Turns running now stop for a moment and continue if “Continue threads after restarts” is on. Where the system restricts Chromium’s sandbox (Ubuntu 24.04 and later), it asks for your password once."
            : "Tau’s host restarts without it. The window on the display closes, and agents’ shells no longer get a DISPLAY."}
          confirmLabel={confirm === "display-add" ? "Add display" : "Remove display"}
          destructive={confirm === "display-remove"}
          onCancel={() => setConfirm(undefined)}
          onConfirm={() => void run(confirm)}
        />
      ) : null}
      {confirm === "uninstall" ? (
        <ConfirmDialog
          title="Remove the service?"
          message="The host stops and no longer starts at login. Running turns stop; this window starts a host of its own again."
          confirmLabel="Remove service"
          destructive
          onCancel={() => setConfirm(undefined)}
          onConfirm={() => void run("uninstall")}
        />
      ) : null}
    </SettingsSection>
  );
}
