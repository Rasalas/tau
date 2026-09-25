import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Info, OctagonAlert, Server } from "lucide-react";
import { Empty, READ_ONLY_REASON, SettingRow, SettingsSection, Skeleton, errorMessage, useCommandAllowed } from "tau";
import type { DesktopExtensionContext, SettingsPageProps } from "tau";
import {
  SERVERS_EXTENSION_ID, decodeServerTargetsState,
  type CredentialCheck, type CredentialSecretStatus, type CredentialStatus, type SecretKind, type ServerTargetIssue, type ServerTargetRow, type ServerTargetsState,
} from "./protocol.js";

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

/** What Tau holds of one secret and what it waits for, in words; never the value. */
export function secretStatusWords(status: CredentialSecretStatus): string[] {
  const words: string[] = [];
  if (status.command === "needs-approval") words.push("the command waits for your approval");
  if (status.command === "allowed") words.push("command allowed for this project");
  if (status.foreignItem) words.push(`VS Code's item ${status.foreignItem.label}: ${status.foreignItem.allowed ? "allowed" : "asks before reading"}`);
  if (status.saved) words.push("saved by Tau");
  if (status.session) words.push("held in memory");
  if (status.unavailable) words.push(status.unavailable);
  return words;
}

function SecretRow({ title, spec, status, busy, allowed, onCheck, onForget }: {
  title: string;
  spec: string;
  status: CredentialSecretStatus | undefined;
  busy: boolean;
  allowed: boolean;
  onCheck(): void;
  onForget(): void;
}) {
  const words = status ? secretStatusWords(status) : [];
  return (
    <SettingRow
      title={title}
      description={<>{status?.source ?? spec}{words.length ? <> · {words.join(" · ")}</> : null}</>}
      disabledReason={allowed ? undefined : READ_ONLY_REASON}
      control={<span className="servers-secret-actions">
        <button type="button" className="chrome-button" disabled={busy || !allowed} onClick={onCheck}>Check</button>
        {status?.saved || status?.session ? <button type="button" className="chrome-button" disabled={busy || !allowed} onClick={onForget}>Forget</button> : null}
      </span>}
    />
  );
}

function TargetSection({ target, credential, busy, allowed, onProfile, onCheck, onForget }: {
  target: ServerTargetRow;
  credential: CredentialStatus | undefined;
  busy: boolean;
  allowed: boolean;
  onProfile(profile: string | undefined): void;
  onCheck(kind: SecretKind): void;
  onForget(): void;
}) {
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
      <SecretRow title="Password" spec={target.password} status={credential?.password} busy={busy} allowed={allowed} onCheck={() => onCheck("password")} onForget={onForget} />
      {target.privateKeyPath ? <SettingRow title="Key" description={<code>{target.privateKeyPath}</code>} /> : null}
      {target.passphrase || target.privateKeyPath ? <SecretRow title="Key passphrase" spec={target.passphrase ?? "Asked when the key needs one"} status={credential?.passphrase} busy={busy} allowed={allowed} onCheck={() => onCheck("passphrase")} onForget={onForget} /> : null}
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
    const [credentials, setCredentials] = useState<Record<string, CredentialStatus>>({});
    const allowed = useCommandAllowed(SERVERS_EXTENSION_ID, "set-profile");

    const loadCredentials = useCallback(() => {
      if (!cwd) return;
      context.host.invoke("credential-status", { cwd }).then((next) => {
        const targets = (next as { targets?: CredentialStatus[] } | undefined)?.targets ?? [];
        setCredentials(Object.fromEntries(targets.map((entry) => [entry.targetId, entry])));
      }, () => undefined);
    }, [cwd]);

    const load = useCallback(() => {
      if (!cwd) return;
      setError(undefined);
      context.host.invoke("targets", { cwd }).then((next) => setState(decodeServerTargetsState(next)), (failure: unknown) => setError(errorMessage(failure)));
      loadCredentials();
    }, [cwd, loadCredentials]);
    useEffect(load, [load]);

    const run = (step: Promise<unknown>, done?: (value: unknown) => void) => {
      setBusy(true);
      step.then((value) => done?.(value), (failure: unknown) => onNotify(errorMessage(failure))).finally(() => { setBusy(false); loadCredentials(); });
    };
    const check = (target: ServerTargetRow, kind: SecretKind) => run(context.host.invoke("check-credential", { cwd, targetId: target.id, kind }), (value) => {
      const result = value as CredentialCheck;
      const what = kind === "password" ? "password" : "passphrase";
      onNotify(result.found ? `${target.label}: found the ${what}. Source: ${result.source ?? "a store"}.` : `${target.label}: no ${what} stored. ${result.message ?? ""}`.trim());
    });
    const forget = (target: ServerTargetRow) => run(context.host.invoke("forget-credential", { cwd, targetId: target.id }), () => onNotify(`Tau forgot what it kept for ${target.label}.`));
    const withdraw = () => run(context.host.invoke("forget-credential-approvals", { cwd }), () => onNotify("Tau will ask again before it runs a command or reads VS Code's items."));
    const approvals = Object.values(credentials).some((entry) => [entry.password, entry.passphrase].some((secret) => secret?.command === "allowed" || secret?.foreignItem?.allowed));

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
          : state.targets.map((target) => <TargetSection
            key={target.id}
            target={target}
            credential={credentials[target.id]}
            busy={busy}
            allowed={allowed}
            onProfile={(profile) => chooseProfile(target, profile)}
            onCheck={(kind) => check(target, kind)}
            onForget={() => forget(target)}
          />)}
        {approvals ? <SettingsSection title="Approvals">
          <SettingRow
            title="Commands and VS Code's keychain items"
            description="What you allowed for this project: commands from sftp.json and reading the items VS Code's SFTP extension saved."
            disabledReason={allowed ? undefined : READ_ONLY_REASON}
            control={<button type="button" className="chrome-button" disabled={busy || !allowed} onClick={withdraw}>Withdraw</button>}
          />
        </SettingsSection> : null}
      </div>
    );
  };
}
