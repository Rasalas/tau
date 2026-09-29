import { useState } from "react";
import {
  Badge,
  Button,
  ConfirmDialog,
  Switch,
  describeHostUpdate,
  errorMessage,
  hostUpdatePending,
  tooltipProps,
  type HostUpdateStatus,
  type PlatformEnvironments,
  type UiEnvironment,
} from "tau";

const BUSY = new Set(["checking", "downloading", "waiting", "installing"]);

function phaseBadge(update: HostUpdateStatus, behind: boolean) {
  if (update.phase === "failed") return <Badge tone="danger">Update failed</Badge>;
  if (update.phase === "installed") return <Badge tone="success">Installed</Badge>;
  if (BUSY.has(update.phase)) return <Badge tone="accent">Updating</Badge>;
  if (behind) return <Badge tone="accent" dot>Update available</Badge>;
  return null;
}

/**
 * A machine's own Tau in Settings → Machines (K103): how its update stands,
 * Update, and whether it updates on its own. Its host decides with this
 * window's key there; a Read-only pairing may look only.
 */
export function MachineUpdateLine({ machine, environments, behind }: {
  machine: UiEnvironment;
  environments: PlatformEnvironments;
  /** Behind by its host's own check, or older than this window. */
  behind: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const update = machine.update;
  if (!update && !behind) return null;
  if (!update || !environments.update) {
    return <small className="machine-update">{machine.name} runs an older Tau that cannot be updated from here; update it there once.</small>;
  }
  const run = (action: "check" | "install" | { automatic: boolean }) => {
    setBusy(true);
    setProblem(undefined);
    environments.update!(machine.id, action).catch((error: unknown) => setProblem(errorMessage(error))).finally(() => setBusy(false));
  };
  const pending = behind || hostUpdatePending(update);
  const unreachable = machine.status !== "connected";
  const why = update.phase === "unsupported" ? update.reason
    : machine.readOnly ? `${machine.name} paired this computer Read only.`
    : unreachable ? `${machine.name} is not connected.`
    : undefined;
  const working = busy || BUSY.has(update.phase);
  return (
    <div className="machine-update">
      <div className="machine-update-line">
        {phaseBadge(update, pending)}
        <small>{describeHostUpdate(update)}</small>
        {update.phase === "unsupported" || update.phase === "installed" ? null : (
          <span {...tooltipProps(why)}>
            <Button busy={working} disabled={working || why !== undefined} variant={pending ? "primary" : "default"} onClick={() => (pending ? setConfirming(true) : run("check"))}>
              {pending ? "Update" : "Check"}
            </Button>
          </span>
        )}
      </div>
      {update.phase === "unsupported" ? null : (
        <span className="machine-update-auto" {...tooltipProps(why)}>
          <Switch label={`Automatic updates on ${machine.name}`} checked={update.automatic} disabled={busy || why !== undefined} onChange={(automatic) => run({ automatic })} />
          <small aria-hidden="true">Automatic updates</small>
        </span>
      )}
      {problem ? <p className="machine-add-result problem" role="status">{problem}</p> : null}
      {confirming ? (
        <ConfirmDialog
          title={`Update Tau on ${machine.name}?`}
          message={`${machine.name} installs Tau ${update.latest ?? "newer"} as soon as no turn runs there, then its host restarts. Its threads stay and this window reconnects.`}
          confirmLabel="Update"
          onConfirm={() => { setConfirming(false); run("install"); }}
          onCancel={() => setConfirming(false)}
        />
      ) : null}
    </div>
  );
}
