import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Info, OctagonAlert, Server } from "lucide-react";
import { Empty, READ_ONLY_REASON, SettingRow, SettingsSection, Skeleton, errorMessage, useCommandAllowed } from "tau";
import type { DesktopExtensionContext, SettingsPageProps } from "tau";
import { SERVERS_EXTENSION_ID, decodeServerTargetsState, type ServerTargetIssue, type ServerTargetRow, type ServerTargetsState } from "./protocol.js";

const ISSUE_ICONS = { error: OctagonAlert, warning: AlertTriangle, info: Info } as const;

export function targetAddress(target: ServerTargetRow): string {
  const user = target.username ? `${target.username}@` : "";
  const host = target.host.includes(":") ? `[${target.host}]` : target.host;
  return `${target.protocol}://${user}${host || "?"}:${target.port}${target.remotePath.startsWith("/") ? "" : "/"}${target.remotePath}`;
}

function Issues({ issues }: { issues: readonly ServerTargetIssue[] }) {
  if (issues.length === 0) return null;
  return <ul className="servers-issues">
    {issues.map((issue, index) => {
      const Icon = ISSUE_ICONS[issue.level];
      return <li key={`${issue.code}-${index}`} className={`servers-issue ${issue.level}`}><Icon size={12} aria-hidden="true" /><span>{issue.message}</span></li>;
    })}
  </ul>;
}

function TargetSection({ target, busy, allowed, onProfile }: { target: ServerTargetRow; busy: boolean; allowed: boolean; onProfile(profile: string | undefined): void }) {
  return (
    <SettingsSection title={target.label}>
      <SettingRow
        title="Server"
        description={<><code>{targetAddress(target)}</code>{target.usable ? null : <> · not usable yet</>}</>}
      />
      <SettingRow title="Local folder" description={target.context ? <code>{target.context}</code> : "The project folder"} />
      {target.profiles.length > 0 ? <SettingRow
        title="Profile"
        description="Merged over the configuration, as in VS Code. Tau keeps the choice on this machine, not in the project."
        disabledReason={allowed ? undefined : READ_ONLY_REASON}
        control={<select
          className="settings-select"
          aria-label={`Profile of ${target.label}`}
          disabled={busy || !allowed}
          value={target.profile ?? ""}
          onChange={(event) => onProfile(event.target.value || undefined)}
        >
          {target.profile ? null : <option value="">None</option>}
          {target.profiles.map((profile) => <option key={profile} value={profile}>{profile}</option>)}
        </select>}
      /> : null}
      <SettingRow title="Password" description={target.password} />
      {target.privateKeyPath ? <SettingRow title="Key" description={<><code>{target.privateKeyPath}</code>{target.passphrase ? <> · passphrase: {target.passphrase}</> : null}</>} /> : null}
      <Issues issues={target.issues} />
    </SettingsSection>
  );
}

/**
 * Settings → Servers: the targets the open project's `.vscode/sftp.json`
 * names, with the profile choice. Host level only; nothing is written into
 * the project.
 */
export function createServersSettingsPage(context: DesktopExtensionContext) {
  return function ServersSettingsPage({ cwd, onNotify }: SettingsPageProps) {
    const [state, setState] = useState<ServerTargetsState>();
    const [error, setError] = useState<string>();
    const [busy, setBusy] = useState(false);
    const allowed = useCommandAllowed(SERVERS_EXTENSION_ID, "set-profile");

    const load = useCallback(() => {
      if (!cwd) return;
      setError(undefined);
      context.host.invoke("targets", { cwd }).then((next) => setState(decodeServerTargetsState(next)), (failure: unknown) => setError(errorMessage(failure)));
    }, [cwd]);
    useEffect(load, [load]);

    const chooseProfile = (target: ServerTargetRow, profile: string | undefined) => {
      setBusy(true);
      context.host.invoke("set-profile", { cwd, configKey: target.configKey, profile: profile ?? null })
        .then((next) => setState(decodeServerTargetsState(next)), (failure: unknown) => onNotify(errorMessage(failure)))
        .finally(() => setBusy(false));
    };

    const header = <>
      <h3>Servers</h3>
      <p className="lede">
        Servers this project deploys to over SFTP or FTP. Tau reads them from <code>.vscode/sftp.json</code>, the file the
        VS Code SFTP extension uses, and never uploads on its own.
      </p>
    </>;
    if (!cwd) return <div className="settings-page servers-settings">{header}<Empty icon={<Server size={18} />} title="No project open" description="Open a project to see its servers." /></div>;
    if (error) return <div className="settings-page servers-settings">{header}<Empty icon={<OctagonAlert size={18} />} title="Could not read the servers" description={error} /></div>;
    if (!state) return <div className="settings-page servers-settings" aria-busy="true">{header}<Skeleton shape="card" /></div>;
    return (
      <div className="settings-page servers-settings">
        {header}
        {state.file ? <p className="settings-group-note">From <code>{state.file}</code></p> : null}
        <Issues issues={state.issues} />
        {state.targets.length === 0
          ? <Empty size="compact" icon={<Server size={16} />} title={state.file ? "sftp.json names no server" : "No sftp.json in this project"} description={state.file ? "Fix the problems above, then open this page again." : "Tau lists the servers of .vscode/sftp.json here."} />
          : state.targets.map((target) => <TargetSection key={target.id} target={target} busy={busy} allowed={allowed} onProfile={(profile) => chooseProfile(target, profile)} />)}
      </div>
    );
  };
}
