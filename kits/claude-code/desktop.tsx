import { useCallback, useEffect, useState } from "react";
import { Bot, CircleCheck, RefreshCw, TriangleAlert } from "lucide-react";
import type { DesktopExtension, HostExtensionClient, RegionProps, SettingsPageProps } from "tau";
import { CLAUDE_CODE_BACKEND_KIND, CLAUDE_CODE_HOST_EXTENSION_ID } from "./protocol.js";

/** Names the runtime behind a Claude thread; Pi threads show nothing. */
export function ClaudeCodeStatus({ snapshot }: RegionProps) {
  if (snapshot?.backendKind !== CLAUDE_CODE_BACKEND_KIND) return null;
  const model = snapshot?.model?.name;
  return <span className="status-item" title={`This thread runs the installed Claude Code CLI through the Agent SDK${model ? ` on ${model}` : ""}.`}><Bot size={12} /> Claude Code</span>;
}

interface StatusReport {
  command: string;
  path?: string;
  /** Who chose `command`: the environment variable or the card; absent for the PATH lookup. */
  commandSource?: "env" | "setting";
  update?: { installed: string; latest: string; command?: string };
}

interface ProbeReport {
  version?: string;
  account?: string;
  defaultModel?: string;
  effort?: string;
  models?: Array<{ id: string; name: string }>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The executable's path, saved when the field is left or Enter is pressed; empty goes back to the PATH. */
function CommandPathField({ status, onSave }: { status: StatusReport | undefined; onSave(command: string): Promise<void> }) {
  const saved = status?.commandSource === "setting" ? status.command : "";
  const [draft, setDraft] = useState(saved);
  useEffect(() => { setDraft(saved); }, [saved]);
  const fromEnv = status?.commandSource === "env";
  const commit = () => { if (draft.trim() !== saved) void onSave(draft.trim()); };
  return (
    <>
      <input
        className="settings-search-input claude-code-path"
        aria-label="Claude Code executable"
        value={fromEnv ? status!.command : draft}
        placeholder="claude, from your login shell's PATH"
        disabled={fromEnv || !status}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => { if (event.key === "Enter") commit(); }}
      />
      <p className="settings-note">{fromEnv ? <>Set by <code>TAU_CLAUDE_CODE_COMMAND</code> in Tau's environment.</> : <>A name on the PATH or an absolute path; leave it empty to find <code>claude</code> on the PATH.</>}</p>
    </>
  );
}

/**
 * Claude Code's card on the Providers page: what the installed CLI is, whether
 * it is current and who it is signed in as. The binary and the login are the
 * user's, so the card reports them and sets only the path.
 */
export function ClaudeCodeProviderCard({ host, onNotify }: SettingsPageProps & { host: HostExtensionClient }) {
  const [status, setStatus] = useState<StatusReport>();
  const [probe, setProbe] = useState<ProbeReport>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const read = useCallback(async (fresh: boolean) => {
    setBusy(true);
    setError(undefined);
    try {
      setStatus(await host.invoke("status") as StatusReport);
      setProbe(await host.invoke("probe", { fresh }) as ProbeReport);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }, [host]);

  useEffect(() => { void read(false); }, [read]);

  const saveCommand = async (command: string) => {
    setError(undefined);
    try {
      await host.invoke("set-command", { command });
      onNotify(command ? `Claude Code runs from ${command}.` : "Claude Code is looked up on the PATH again.");
      await read(true);
    } catch (failure) {
      setError(errorMessage(failure));
    }
  };

  const known = status !== undefined;
  const found = Boolean(status?.path);
  return (
    <>
      <p className="settings-note">
        Threads drive the CLI you installed, through the Agent SDK, with its login and the settings in your
        {" "}<code>~/.claude</code>. Tau adds nothing to them and reads no credential.
      </p>

      <div className="settings-label">CLI</div>
      <div className="settings-field claude-code-field">
        {found ? <CircleCheck size={14} className="accent" /> : <TriangleAlert size={14} />}
        <span>
          <strong>{!known ? "Checking…" : found ? `Found${probe?.version ? ` · ${probe.version}` : ""}` : `${status.command} was not found`}</strong>
          <small>{!known ? "" : found ? status.path : "Install it from claude.ai/code, or set its path below."}</small>
        </span>
        <button className="claude-code-action" disabled={busy} onClick={() => void read(true)}>
          <RefreshCw size={13} /> {busy ? "Asking…" : "Check again"}
        </button>
      </div>
      {status?.update ? <p className="settings-note">Claude Code {status.update.latest} is out; {status.update.installed} is installed.{status.update.command ? <> Update with <code>{status.update.command}</code>.</> : null}</p> : null}

      <div className="settings-label">Account</div>
      <div className="settings-field claude-code-field">
        {probe?.account ? <CircleCheck size={14} className="accent" /> : <TriangleAlert size={14} />}
        <span>
          <strong>{!known ? "Checking…" : probe?.account ?? "Not signed in"}</strong>
          <small>{probe?.account ? "Sign in and out with the CLI itself; Tau uses whatever it is signed in as." : "Run the CLI once in a terminal to sign in."}</small>
        </span>
      </div>

      {probe?.models?.length ? (
        <p className="settings-note">
          {probe.models.length} models available{probe.defaultModel ? `, ${probe.defaultModel} by default` : ""}
          {probe.effort ? `, effort ${probe.effort}` : ""}. Pick one per thread in the composer.
        </p>
      ) : null}

      <div className="settings-label">Path</div>
      <CommandPathField status={status} onSave={saveCommand} />
      {error ? <p className="settings-note" data-level="error">{error}</p> : null}
    </>
  );
}

/**
 * Claude Code's desktop half: it marks Claude threads and fills Claude Code's
 * card on the Providers page. The backend itself is the host entry.
 */
export const claudeCodeExtension: DesktopExtension = {
  id: CLAUDE_CODE_HOST_EXTENSION_ID,
  name: "Claude Code",
  activate(plugin) {
    const stops = [
      plugin.registerStatusItem({ id: "claude-code.runtime", align: "left", order: 40, profiles: ["desktop", "web", "compact"], Component: ClaudeCodeStatus }),
      plugin.registerSettingsPage({
        id: "claude-code.settings",
        label: "Claude Code",
        profiles: ["desktop", "web"],
        runtime: CLAUDE_CODE_BACKEND_KIND,
        order: 25,
        Component: (props: SettingsPageProps) => <ClaudeCodeProviderCard {...props} host={plugin.host} />,
      }),
    ];
    return () => { for (const stop of stops) stop(); };
  },
};

export default claudeCodeExtension;
