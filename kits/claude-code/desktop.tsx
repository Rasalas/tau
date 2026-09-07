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

/**
 * What the installed CLI is and who it is signed in as. Nothing here is Tau's
 * to change: the binary is the user's install and the login is the CLI's own,
 * so the page reports and refreshes, and never edits.
 */
export function ClaudeCodeSettingsPage({ host }: SettingsPageProps & { host: HostExtensionClient }) {
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

  const found = Boolean(status?.path);
  return (
    <div className="settings-page">
      <h3>Claude Code</h3>
      <p className="lede">
        Claude Code threads drive the CLI you installed, through the Agent SDK. Its login and its settings are the
        ones in your <code>~/.claude</code>; Tau adds nothing to them and reads no credential.
      </p>

      <div className="settings-label">CLI</div>
      <div className="settings-field claude-code-field">
        {found ? <CircleCheck size={14} className="accent" /> : <TriangleAlert size={14} />}
        <span>
          <strong>{found ? `Found${probe?.version ? ` · ${probe.version}` : ""}` : `${status?.command ?? "claude"} was not found`}</strong>
          <small>{found ? status?.path : "Install it from claude.ai/code, or point TAU_CLAUDE_CODE_COMMAND at the executable."}</small>
        </span>
        <button className="claude-code-action" disabled={busy} onClick={() => void read(true)}>
          <RefreshCw size={13} /> {busy ? "Asking…" : "Check again"}
        </button>
      </div>

      <div className="settings-label">ACCOUNT</div>
      <div className="settings-field claude-code-field">
        {probe?.account ? <CircleCheck size={14} className="accent" /> : <TriangleAlert size={14} />}
        <span>
          <strong>{probe?.account ?? "Not signed in"}</strong>
          <small>{probe?.account ? "Sign in and out with the CLI itself; Tau uses whatever it is signed in as." : "Run the CLI once in a terminal to sign in."}</small>
        </span>
      </div>

      {probe?.models?.length ? (
        <>
          <div className="settings-label">MODELS</div>
          <p className="settings-note">
            {probe.models.length} available{probe.defaultModel ? `, ${probe.defaultModel} by default` : ""}
            {probe.effort ? `, effort ${probe.effort}` : ""}. Pick one per thread in the composer.
          </p>
        </>
      ) : null}
      {error ? <p className="settings-note" data-level="error">{error}</p> : null}
    </div>
  );
}

/**
 * Claude Code's desktop half: it marks Claude threads and owns the page that
 * reports the CLI and its login. The backend itself is the host entry.
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
        Icon: Bot,
        order: 25,
        Component: (props: SettingsPageProps) => <ClaudeCodeSettingsPage {...props} host={plugin.host} />,
      }),
    ];
    return () => { for (const stop of stops) stop(); };
  },
};

export default claudeCodeExtension;
