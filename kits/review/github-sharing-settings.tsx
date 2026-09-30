import { useCallback, useEffect, useState } from "react";
import { Button, errorMessage, Select, SettingRow, SettingsSection, SettingsState, Switch, TextField, type HostExtensionClient } from "tau";
import type { GitHubRoutingRow, GitHubSharing } from "./github-routing.js";
const MODES = [{ value: "off", label: "Off" }, { value: "read", label: "Read PRs" }, { value: "act", label: "Read and act" }] as const;

function SharingRow({ row, peers, save }: { row: GitHubRoutingRow; peers: GitHubRoutingRow[]; save(row: GitHubRoutingRow): void }) {
  const [host, setHost] = useState(row.host);
  const [machine, setMachine] = useState(row.machine ?? "");
  return <SettingRow title={row.name} description={`${row.direction === "machine" ? "Use this host's GitHub sign-in" : "Let this device use this host's GitHub sign-in"}. ${row.status}.`}
    control={<div className="review-server-add">
      <TextField label={`GitHub endpoint for ${row.name}`} mono width="md" value={host} onChange={setHost} onCommit={(next) => { setHost(next); save({ ...row, host: next, mode: "off" }); }} />
      {row.direction === "device" ? <Select label={`Source host for ${row.name}`} value={machine} options={[{ value: "", label: "Choose source host" }, ...peers.map((peer) => ({ value: peer.id, label: peer.name }))]} onChange={(next) => { setMachine(next); save({ ...row, machine: next, mode: "off" }); }} /> : null}
      {row.direction === "machine" && row.mode === "act" ? <label>Use for actions <Switch label={`Use ${row.name} for GitHub actions`} checked={row.preferred === true} onChange={(preferred) => save({ ...row, host, machine, preferred })} /></label> : null}
      <Select<GitHubSharing> label={`GitHub sharing for ${row.name}`} value={row.mode} options={MODES} onChange={(mode) => save({ ...row, host, machine, mode })} />
    </div>} />;
}

export function GitHubSharingSettings({ host, onNotify }: { host: HostExtensionClient; onNotify(message: string): void }) {
  const [rows, setRows] = useState<GitHubRoutingRow[]>();
  const [error, setError] = useState<string>();
  const refresh = useCallback(async () => {
    try { setRows(await host.invoke("github-sharing") as GitHubRoutingRow[]); setError(undefined); }
    catch (reason) { setError(errorMessage(reason)); }
  }, [host]);
  useEffect(() => { void refresh(); }, [refresh]);
  const save = async (row: GitHubRoutingRow) => {
    try { await host.invoke("github-sharing-set", row); }
    catch (reason) { onNotify(errorMessage(reason)); }
    await refresh();
  };
  return <SettingsSection id="setting-review-github-sharing" title="GitHub across paired hosts" headerAction={<Button variant="ghost" onClick={() => void refresh()}>Check again</Button>}>
    <p>Choose a host here and approve this computer’s paired device on that host. Both must verify the same GitHub account. Each host needs a paired connection to the other with “Agents may work there” enabled. Credentials stay on the host that runs the request. Removing a paired host or device, changing its endpoint or key, or revoking access turns sharing off.</p>
    {error ? <SettingsState kind="error" title="Sharing could not be checked" description={error} onRetry={() => void refresh()} />
      : !rows ? <SettingsState kind="loading" title="Checking paired hosts" rows={2} />
      : rows.length ? rows.map((row) => <SharingRow key={`${row.direction}/${row.id}`} row={row} peers={rows.filter((entry) => entry.direction === "machine")} save={(next) => void save(next)} />)
      : <p>Pair another host in Settings → Machines to share GitHub access.</p>}
  </SettingsSection>;
}
