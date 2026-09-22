import { useCallback, useEffect, useState } from "react";
import { CircleCheck, RefreshCw, SquareTerminal, TriangleAlert } from "lucide-react";
import type { DesktopExtension, HostExtensionClient, RegionProps, SettingsPageProps } from "tau";
import { CODEX_BACKEND_KIND, CODEX_HOST_EXTENSION_ID, MIN_CODEX_VERSION, type CodexStatusReport } from "./protocol.js";

/** Names the runtime behind a Codex thread; other threads show nothing. */
export function CodexStatus({ snapshot }: RegionProps) {
  if (snapshot?.backendKind !== CODEX_BACKEND_KIND) return null;
  const model = snapshot?.model?.name;
  return <span className="status-item" title={`This thread runs the installed Codex CLI through its app server${model ? ` on ${model}` : ""}.`}><SquareTerminal size={12} /> Codex</span>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const PLAN_NAMES: Record<string, string> = { free: "Free", go: "Go", plus: "Plus", pro: "Pro", team: "Team", business: "Business", enterprise: "Enterprise", edu: "Edu" };

function accountLabel(account: CodexStatusReport["account"]): string | undefined {
  if (!account) return undefined;
  if (account.kind === "chatgpt") return `ChatGPT${account.plan ? ` ${PLAN_NAMES[account.plan] ?? account.plan}` : ""}${account.email ? ` · ${account.email}` : ""}`;
  return account.kind === "apiKey" ? "API key" : "signed in";
}

/**
 * What the installed CLI is, whether it is current, and who it is signed in
 * as. The binary and the login are the user's: the page reports, it never
 * edits either.
 */
export function CodexSettingsPage({ host }: SettingsPageProps & { host: HostExtensionClient }) {
  const [status, setStatus] = useState<CodexStatusReport>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const read = useCallback(async (fresh: boolean) => {
    setBusy(true);
    setError(undefined);
    try {
      setStatus(await host.invoke("status", { fresh }) as CodexStatusReport);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }, [host]);

  useEffect(() => { void read(false); }, [read]);

  const known = status !== undefined;
  const found = Boolean(status?.path);
  const account = accountLabel(status?.account);
  return (
    <div className="settings-page">
      <h3>Codex</h3>
      <p className="lede">
        Codex threads drive the CLI you installed, through its app server. Its login and its sessions are the ones in
        your <code>~/.codex</code> (or <code>CODEX_HOME</code>); Tau reads no credential.
      </p>

      <div className="settings-label">CLI</div>
      <div className="settings-field codex-field">
        {found && !status?.unsupported ? <CircleCheck size={14} className="accent" /> : <TriangleAlert size={14} />}
        <span>
          <strong>{!known ? "Checking…" : found ? `Found${status?.version ? ` · ${status.version}` : ""}` : `${status.command} was not found`}</strong>
          <small>{!known ? "" : found ? status.path : status.message ?? "Install it, or point TAU_CODEX_COMMAND at the executable."}</small>
        </span>
        <button className="codex-action" disabled={busy} onClick={() => void read(true)}>
          <RefreshCw size={13} /> {busy ? "Asking…" : "Check again"}
        </button>
      </div>
      {status?.unsupported ? <p className="settings-note" data-level="error">Tau speaks to Codex {MIN_CODEX_VERSION} and newer. Update it with <code>{status.updateCommand}</code>.</p> : null}
      {!status?.unsupported && status?.updateAvailable ? <p className="settings-note">Codex {status.latest} is out. Update with <code>{status.updateCommand}</code>.</p> : null}

      <div className="settings-label">ACCOUNT</div>
      <div className="settings-field codex-field">
        {account ? <CircleCheck size={14} className="accent" /> : <TriangleAlert size={14} />}
        <span>
          <strong>{!known || (found && busy && !status?.signedIn) ? "Checking…" : account ?? "Not signed in"}</strong>
          <small>{account ? "Sign in and out with the CLI itself; Tau uses whatever it is signed in as." : <>Run <code>codex login</code> in a terminal to sign in with your ChatGPT plan.</>}</small>
        </span>
      </div>
      {status?.codexHome ? <p className="settings-note">Home: <code>{status.codexHome}</code>{status.models ? ` · ${status.models} models; pick one and its reasoning effort per thread in the composer.` : ""}</p> : null}
      {error ? <p className="settings-note" data-level="error">{error}</p> : null}
    </div>
  );
}

/**
 * Codex's desktop half: it marks Codex threads and owns the page that reports
 * the CLI, its version and its login. The backend itself is the host entry.
 */
export const codexExtension: DesktopExtension = {
  id: CODEX_HOST_EXTENSION_ID,
  name: "Codex",
  activate(plugin) {
    const stops = [
      plugin.registerStatusItem({ id: "codex.runtime", align: "left", order: 42, profiles: ["desktop", "web", "compact"], Component: CodexStatus }),
      plugin.registerSettingsPage({
        id: "codex.settings",
        label: "Codex",
        profiles: ["desktop", "web"],
        Icon: SquareTerminal,
        order: 27,
        Component: (props: SettingsPageProps) => <CodexSettingsPage {...props} host={plugin.host} />,
      }),
    ];
    return () => { for (const stop of stops) stop(); };
  },
};

export default codexExtension;
