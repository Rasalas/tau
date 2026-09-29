import { useState, type ReactNode } from "react";
import { describeHostUpdate, hostUpdatePending, type HostUpdateStatus } from "../../shared/host-updates";
import { errorMessage } from "../../workbench/error-message";
import { useHostClient } from "../host-client-context";
import { useHostUpdate } from "../machine-updates";
import { Badge, Button, Switch } from "./controls";
import { formatAgo } from "./connections-format";
import { SettingRow, SettingsSection } from "./settings-layout";
import { settingAnchor } from "./settings-search";

const BUSY = new Set(["checking", "downloading", "waiting", "installing"]);

function actionLabel(status: HostUpdateStatus): string {
  switch (status.phase) {
    case "checking": return "Checking…";
    case "downloading": return status.progress !== undefined ? `Downloading ${status.progress}%` : "Downloading…";
    case "waiting": return "Waiting for turns…";
    case "installing": return "Installing…";
    default: return hostUpdatePending(status) ? "Update now" : "Check now";
  }
}

function badge(status: HostUpdateStatus) {
  if (status.phase === "unsupported") return <Badge>Updates by hand</Badge>;
  if (status.phase === "failed") return <Badge tone="danger">Failed</Badge>;
  if (status.phase === "installed") return <Badge tone="success">Installed</Badge>;
  if (hostUpdatePending(status)) return <Badge tone="accent" dot>Update available</Badge>;
  if (status.phase === "current") return <Badge tone="success">Up to date</Badge>;
  return null;
}

/**
 * Settings → About: the Tau of the machine this client's host runs on (K103).
 * The same for a window, a browser and a phone: version, how its update
 * stands, Update now, and whether it updates on its own.
 */
export function HostUpdateSection({ fallback }: { fallback?: ReactNode }) {
  const client = useHostClient();
  const { status, unavailable, store } = useHostUpdate();
  const [problem, setProblem] = useState<string>();
  const [asking, setAsking] = useState(false);
  if (!status) return unavailable === undefined ? null : <>{fallback}</>;
  const machine = client?.getHostName?.() ?? "this machine";
  const readOnly = client?.isReadOnly() === true;
  const owner = client?.isOwner?.() === true;
  const pending = hostUpdatePending(status);
  const busy = asking || BUSY.has(status.phase);
  const run = (action: () => Promise<unknown>) => {
    setAsking(true);
    setProblem(undefined);
    action().catch((error: unknown) => setProblem(errorMessage(error))).finally(() => setAsking(false));
  };
  const cannotInstall = status.phase === "unsupported" ? status.reason
    : readOnly ? "Read only: this needs a device with Full access."
    : pending && !owner && !status.devicesMayInstall ? `${machine}'s owner lets only its own Tau window install updates.`
    : undefined;
  const checked = status.checkedAt ? ` Checked ${formatAgo(new Date(status.checkedAt).toISOString(), Date.now())}.` : "";
  return (
    <SettingsSection title="Updates" id={settingAnchor("Updates")}>
      <SettingRow
        id={settingAnchor("Update now")}
        title={<>Tau {status.version} on {machine} {badge(status)}</>}
        description={`${describeHostUpdate(status)}${status.phase === "unsupported" ? "" : checked}`}
        disabledReason={cannotInstall}
        control={status.phase === "installed" ? null : (
          <Button
            variant={pending && !busy ? "primary" : "default"}
            busy={busy}
            disabled={busy || cannotInstall !== undefined}
            onClick={() => run(() => (pending ? store!.install() : store!.check()))}
          >
            {asking && !BUSY.has(status.phase) ? (pending ? "Starting…" : "Checking…") : actionLabel(status)}
          </Button>
        )}
      />
      {problem ? <p className="settings-group-note machine-warning" role="status">{problem}</p> : null}
      {status.phase === "unsupported" ? null : (
        <SettingRow
          id={settingAnchor("Automatic updates")}
          title="Automatic updates"
          description={status.installer === "window"
            ? "A Tau window on this machine installs updates; it downloads them on its own and installs on restart."
            : "Checks every six hours, downloads in the background and installs once no turn has run for 15 minutes."}
          disabledReason={readOnly ? "Read only: this needs a device with Full access." : undefined}
          control={<Switch label="Automatic updates" checked={status.automatic} disabled={readOnly} onChange={(automatic) => run(() => store!.setSettings({ automatic }))} />}
        />
      )}
      {status.phase === "unsupported" || !owner ? null : (
        <SettingRow
          id={settingAnchor("Paired devices may update")}
          title="Paired devices may update this machine"
          description="A phone or another computer paired with Full access may start an update here. Read-only devices never can."
          control={<Switch label="Paired devices may update this machine" checked={status.devicesMayInstall} onChange={(devicesMayInstall) => run(() => store!.setSettings({ devicesMayInstall }))} />}
        />
      )}
    </SettingsSection>
  );
}
