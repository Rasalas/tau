import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Info, OctagonAlert } from "lucide-react";
import { Button, READ_ONLY_REASON, SegmentedControl, Select, SettingRow, SettingsSection, SettingsState, errorMessage, useCommandAllowed, useSetting } from "tau";
import type { DesktopExtensionContext, SettingsPageProps } from "tau";
import {
  DEFAULT_RETENTION_COUNT, DEFAULT_RETENTION_DAYS, RETENTION_COUNT_KEY, RETENTION_DAYS_KEY, SERVERS_EXTENSION_ID, TARGET_LEVELS, decodeServerTargetsState, type TargetLevel,
  type CredentialCheck, type CredentialSecretStatus, type CredentialStatus, type SecretKind, type ServerTargetIssue, type ServerTargetRow, type ServerTargetsState,
} from "./protocol.js";
import { NetworkSection } from "./network-settings.js";
import type { HistoryCleanupResult } from "./rollback-protocol.js";

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
        <Button disabled={busy || !allowed} onClick={onCheck}>Check</Button>
        {status?.saved || status?.session ? <Button disabled={busy || !allowed} onClick={onForget}>Forget</Button> : null}
      </span>}
    />
  );
}

export const LEVEL_WORDS: Readonly<Record<TargetLevel, { label: string; description: string }>> = {
  "read-only": { label: "Read only", description: "The agent reads the server and runs no commands there." },
  ask: { label: "Ask first", description: "The agent asks you before each command it runs on the server." },
  full: { label: "Full access", description: "The agent runs commands on the server without asking. Writing Git there stays blocked." },
};

function TargetSection({ target, credential, level, busy, allowed, levelAllowed, onProfile, onLevel, onCheck, onForget }: {
  target: ServerTargetRow;
  credential: CredentialStatus | undefined;
  level: TargetLevel | undefined;
  busy: boolean;
  allowed: boolean;
  levelAllowed: boolean;
  onProfile(profile: string | undefined): void;
  onLevel(level: TargetLevel): void;
  onCheck(kind: SecretKind): void;
  onForget(): void;
}) {
  return (
    <SettingsSection title={target.label} id={`servers-target-${target.id}`}>
      <SettingRow
        title="Server"
        description={<><code>{targetAddress(target)}</code>{target.usable ? null : <> · not usable yet</>}</>}
      />
      <SettingRow title="Local folder" description={target.context ? <code>{target.context}</code> : "The project folder"} />
      {target.profiles.length > 0 ? <SettingRow
        title="Profile"
        description="Merged over the configuration, as in VS Code. Tau keeps the choice on this machine, not in the project."
        disabledReason={allowed ? undefined : READ_ONLY_REASON}
        control={<Select
          label={`Profile of ${target.label}`}
          disabled={busy || !allowed}
          value={target.profile}
          placeholder="None"
          options={target.profiles.map((profile) => ({ value: profile, label: profile }))}
          onChange={(profile) => onProfile(profile)}
        />}
      /> : null}
      {/* FTP runs no commands: nothing to allow. */}
      {target.protocol === "ftp" ? null : <SettingRow
        title="Commands on the server"
        description={`${level ? LEVEL_WORDS[level].description : "Reading what the agent may run…"} Uploads are always yours.`}
        disabledReason={levelAllowed ? undefined : READ_ONLY_REASON}
        control={<SegmentedControl
          label={`What the agent may run on ${target.label}`}
          disabled={busy || !levelAllowed || !level}
          value={level}
          options={TARGET_LEVELS.map((entry) => ({ value: entry, label: LEVEL_WORDS[entry].label }))}
          onChange={onLevel}
        />}
      />}
      <SecretRow title="Password" spec={target.password} status={credential?.password} busy={busy} allowed={allowed} onCheck={() => onCheck("password")} onForget={onForget} />
      {target.privateKeyPath ? <SettingRow title="Key" description={<code>{target.privateKeyPath}</code>} /> : null}
      {target.passphrase || target.privateKeyPath ? <SecretRow title="Key passphrase" spec={target.passphrase ?? "Asked when the key needs one"} status={credential?.passphrase} busy={busy} allowed={allowed} onCheck={() => onCheck("passphrase")} onForget={onForget} /> : null}
      <Issues issues={target.issues} />
    </SettingsSection>
  );
}

const RETENTION_DAYS = ["1", "7", "30", "90", "180", "365"];
const RETENTION_COUNTS = ["1", "10", "50", "200", "500", "1000"];
const readChoice = (choices: readonly string[]) => (raw: unknown) => (typeof raw === "string" && choices.includes(raw) ? raw : undefined);

const DAY_OPTIONS = RETENTION_DAYS.map((value) => ({ value, label: `${value} ${value === "1" ? "day" : "days"}` }));
const COUNT_OPTIONS = RETENTION_COUNTS.map((value) => ({ value, label: value === "1" ? "The newest only" : `${value} entries` }));

/** How long Tau keeps the recorded server states and deployments; this machine's setting. */
function RetentionSection({ busy, cleanAllowed, onClean }: { busy: boolean; cleanAllowed: boolean; onClean(): void }) {
  const days = useSetting<string>(`values.${SERVERS_EXTENSION_ID}.${RETENTION_DAYS_KEY}`, { defaultValue: String(DEFAULT_RETENTION_DAYS), scope: "host", read: readChoice(RETENTION_DAYS), format: (value) => `${value} days` });
  const count = useSetting<string>(`values.${SERVERS_EXTENSION_ID}.${RETENTION_COUNT_KEY}`, { defaultValue: String(DEFAULT_RETENTION_COUNT), scope: "host", read: readChoice(RETENTION_COUNTS), format: (value) => `${value} entries` });
  return (
    <SettingsSection title="History">
      <SettingRow
        id="setting-servers-keep-for"
        title="Keep for"
        description="Recorded server states and deployments older than this are cleaned up, per server."
        setting={days}
        control={<Select label="Keep the history for" value={days.value} width="sm" options={DAY_OPTIONS} onChange={days.set} />}
      />
      <SettingRow
        id="setting-servers-keep-at-most"
        title="Keep at most"
        description="The newest entries per server stay; older ones go first."
        setting={count}
        control={<Select label="Keep at most this many entries" value={count.value} options={COUNT_OPTIONS} onChange={count.set} />}
      />
      <SettingRow
        id="setting-servers-clean-up"
        title="Clean up now"
        description="Tau cleans up every hour. Dropped deployments can no longer be rolled back."
        disabledReason={cleanAllowed ? undefined : READ_ONLY_REASON}
        control={<Button busy={busy} disabled={!cleanAllowed} onClick={onClean}>Clean up</Button>}
      />
    </SettingsSection>
  );
}

/** The rows the Settings search finds; each id is a row's on the page once a project with servers is open. */
export const SERVERS_SETTINGS_ROWS = [
  { id: "setting-servers-network", label: "Agent commands", keywords: ["network", "sandbox", "whole network", "limit", "localhost"] },
  { id: "setting-servers-allowed-hosts", label: "Allowed hosts", keywords: ["network", "host", "staging", "allow"] },
  { id: "setting-servers-package-sources", label: "Package sources", keywords: ["npm", "packagist", "pypi", "registry"] },
  { id: "setting-servers-approvals", label: "Commands and VS Code's keychain items", keywords: ["approvals", "withdraw", "keychain", "password"] },
  { id: "setting-servers-keep-for", label: "Keep for", keywords: ["history", "retention", "days", "deployments"] },
  { id: "setting-servers-keep-at-most", label: "Keep at most", keywords: ["history", "retention", "entries", "deployments"] },
  { id: "setting-servers-clean-up", label: "Clean up now", keywords: ["history", "deployments", "rollback"] },
];

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
    const levelAllowed = useCommandAllowed(SERVERS_EXTENSION_ID, "set-target-level");
    const cleanAllowed = useCommandAllowed(SERVERS_EXTENSION_ID, "cleanup-history");
    const [levels, setLevels] = useState<Record<string, TargetLevel>>({});

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
      context.host.invoke("target-levels", { cwd }).then((next) => setLevels((next as { levels?: Record<string, TargetLevel> } | undefined)?.levels ?? {}), () => undefined);
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

    const clean = () => run(context.host.invoke("cleanup-history", { cwd }), (value) => {
      const targets = (value as { targets?: HistoryCleanupResult[] } | undefined)?.targets ?? [];
      const removed = targets.reduce((sum, entry) => sum + entry.removed.length, 0);
      onNotify(removed ? `Cleaned up: ${removed} ${removed === 1 ? "deployment" : "deployments"} dropped, the rest kept.` : "Cleaned up: every deployment is within what Tau keeps.");
    });

    const chooseLevel = (target: ServerTargetRow, level: TargetLevel) => run(context.host.invoke("set-target-level", { cwd, targetId: target.id, level }), (value) => {
      setLevels((current) => ({ ...current, [target.id]: (value as { level: TargetLevel }).level }));
    });

    const chooseProfile = (target: ServerTargetRow, profile: string | undefined) => {
      setBusy(true);
      context.host.invoke("set-profile", { cwd, configKey: target.configKey, profile: profile ?? null })
        .then((next) => setState(decodeServerTargetsState(next)), (failure: unknown) => onNotify(errorMessage(failure)))
        .finally(() => setBusy(false));
    };

    const header = <>
      <h3>Servers</h3>
      <p className="lede">
        Servers this project deploys to over SFTP or FTP. Tau reads them from {state?.file ? <code>{state.file}</code> : <code>.vscode/sftp.json</code>}, the
        file the VS Code SFTP extension uses, and never uploads on its own.
      </p>
    </>;
    if (!cwd) return <div className="settings-page servers-settings">{header}<SettingsState kind="empty" title="No project open" description="Open a project to see its servers." /></div>;
    if (error) return <div className="settings-page servers-settings">{header}<SettingsState kind="error" title="Could not read the servers" description={error} onRetry={load} /></div>;
    if (!state) return <div className="settings-page servers-settings">{header}<SettingsState kind="loading" rows={4} title="Reading the servers" /></div>;
    return (
      <div className="settings-page servers-settings">
        {header}
        <Issues issues={state.issues} />
        {state.targets.length === 0
          ? <SettingsState kind="empty" title={state.file ? "sftp.json names no server" : "No sftp.json in this project"} description={state.file ? "Fix the problems above, then open this page again." : "Tau lists the servers of .vscode/sftp.json here."} />
          : state.targets.map((target) => <TargetSection
            key={target.id}
            target={target}
            credential={credentials[target.id]}
            level={levels[target.id]}
            busy={busy}
            allowed={allowed}
            levelAllowed={levelAllowed}
            onProfile={(profile) => chooseProfile(target, profile)}
            onLevel={(level) => chooseLevel(target, level)}
            onCheck={(kind) => check(target, kind)}
            onForget={() => forget(target)}
          />)}
        <NetworkSection context={context} cwd={cwd} onNotify={onNotify} />
        {approvals ? <SettingsSection title="Approvals">
          <SettingRow
            id="setting-servers-approvals"
            title="Commands and VS Code's keychain items"
            description="What you allowed for this project: commands from sftp.json and reading the items VS Code's SFTP extension saved."
            disabledReason={allowed ? undefined : READ_ONLY_REASON}
            control={<Button disabled={busy || !allowed} onClick={withdraw}>Withdraw</Button>}
          />
        </SettingsSection> : null}
        {state.targets.length > 0 ? <RetentionSection busy={busy} cleanAllowed={cleanAllowed} onClean={clean} /> : null}
      </div>
    );
  };
}
