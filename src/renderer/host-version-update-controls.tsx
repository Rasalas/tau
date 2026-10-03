import { useMemo, useSyncExternalStore } from "react";
import { hostUpdatePending } from "../shared/host-updates";
import { hostUpdateStore } from "../workbench/host-update-store";
import { useHostClient } from "./host-client-context";
import { useAppUpdate } from "./renderer-services-context";
import { tooltipProps } from "./components/ui/Tooltip";

const progress = (phase: string | undefined, percent: number | undefined) => phase === "downloading" ? `Downloading${percent === undefined ? "…" : ` ${percent}%`}`
  : phase === "waiting" ? "Waiting for turns…" : phase === "installing" ? "Installing…" : phase === "checking" ? "Checking…" : undefined;

/** The window's own Tau: restart into a downloaded release, or ask its updater, which reports what it found. */
export function UpdateWindowButton() {
  const client = useHostClient();
  const update = useAppUpdate();
  return update
    ? <button type="button" className="text-button" disabled={Boolean(update.phase)} onClick={() => update.install()}>{progress(update.phase, update.progress) ?? `Restart to update to ${update.version}`}</button>
    : <button type="button" className="text-button" onClick={() => void client?.windowAction({ kind: "check-for-updates" }).catch(() => undefined)}>Check for updates</button>;
}

/** The host's own Tau through its updater (K103); a failure comes back as its status. */
export function UpdateHostButton() {
  const client = useHostClient();
  const store = useMemo(() => (client ? hostUpdateStore(client) : undefined), [client]);
  const status = useSyncExternalStore(store?.subscribe ?? (() => () => undefined), () => store?.getSnapshot().status);
  if (!status || !store || status.phase === "unsupported") return null;
  const pending = hostUpdatePending(status);
  const refused = client?.isReadOnly() || (pending && !client?.isOwner?.() && !status.devicesMayInstall);
  const busy = progress(status.phase, status.progress);
  return <button
    type="button"
    className="text-button"
    disabled={Boolean(busy || refused)}
    {...tooltipProps(refused ? "Only a device with Full access may update this host." : status.phase === "failed" ? status.reason : undefined)}
    onClick={() => void (pending ? store.install() : store.check()).catch(() => undefined)}
  >{busy ?? (pending ? "Update host" : "Check for updates")}</button>;
}
