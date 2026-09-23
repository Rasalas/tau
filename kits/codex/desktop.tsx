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

/** The executable's path, saved when the field is left or Enter is pressed; empty goes back to the PATH. */
export function CommandPathField({ status, onSave }: { status: CodexStatusReport | undefined; onSave(command: string): Promise<void> }) {
  const saved = status?.commandSource === "setting" ? status.command : "";
  const [draft, setDraft] = useState(saved);
  useEffect(() => { setDraft(saved); }, [saved]);
  const fromEnv = status?.commandSource === "env";
  const commit = () => { if (draft.trim() !== saved) void onSave(draft.trim()); };
  return (
    <>
      <input
        className="settings-search-input codex-path"
        aria-label="Codex executable"
        value={fromEnv ? status!.command : draft}
        placeholder="codex, from your login shell's PATH"
        disabled={fromEnv || !status}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => { if (event.key === "Enter") commit(); }}
      />
      <p className="settings-note">{fromEnv ? <>Set by <code>TAU_CODEX_COMMAND</code> in Tau's environment.</> : <>A name on the PATH or an absolute path; leave it empty to find <code>codex</code> on the PATH.</>}</p>
    </>
  );
}

/**
 * Codex's card on the Providers page: the installed CLI, whether it is
 * current, who it is signed in as and where Tau finds it. The binary and the
 * login are the user's: the card reports them and sets only the path.
 */
export function CodexProviderCard({ host, onNotify }: SettingsPageProps & { host: HostExtensionClient }) {
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

  const saveCommand = async (command: string) => {
    setError(undefined);
    try {
      await host.invoke("set-command", { command });
      onNotify(command ? `Codex runs from ${command}.` : "Codex is looked up on the PATH again.");
      await read(true);
    } catch (failure) {
      setError(errorMessage(failure));
    }
  };

  const known = status !== undefined;
  const found = Boolean(status?.path);
  const account = accountLabel(status?.account);
  return (
    <>
      <p className="settings-note">
        Threads drive the CLI you installed, through its app server, with its login and the sessions in your
        {" "}<code>~/.codex</code> (or <code>CODEX_HOME</code>). Tau reads no credential.
      </p>

      <div className="settings-label">CLI</div>
      <div className="settings-field codex-field">
        {found && !status?.unsupported ? <CircleCheck size={14} className="accent" /> : <TriangleAlert size={14} />}
        <span>
          <strong>{!known ? "Checking…" : found ? `Found${status?.version ? ` · ${status.version}` : ""}` : `${status.command} was not found`}</strong>
          <small>{!known ? "" : found ? status.path : status.message ?? "Install it, or set its path below."}</small>
        </span>
        <button className="codex-action" disabled={busy} onClick={() => void read(true)}>
          <RefreshCw size={13} /> {busy ? "Asking…" : "Check again"}
        </button>
      </div>
      {status?.unsupported ? <p className="settings-note" data-level="error">Tau speaks to Codex {MIN_CODEX_VERSION} and newer. Update it with <code>{status.updateCommand}</code>.</p> : null}
      {!status?.unsupported && status?.updateAvailable ? <p className="settings-note">Codex {status.latest} is out. Update with <code>{status.updateCommand}</code>.</p> : null}

      <div className="settings-label">Account</div>
      <div className="settings-field codex-field">
        {account ? <CircleCheck size={14} className="accent" /> : <TriangleAlert size={14} />}
        <span>
          <strong>{!known || (found && busy && !status?.signedIn) ? "Checking…" : account ?? "Not signed in"}</strong>
          <small>{account ? "Sign in and out with the CLI itself; Tau uses whatever it is signed in as." : <>Run <code>codex login</code> in a terminal to sign in with your ChatGPT plan.</>}</small>
        </span>
      </div>
      {status?.codexHome ? <p className="settings-note">Home: <code>{status.codexHome}</code>{status.models ? ` · ${status.models} models; pick one and its reasoning effort per thread in the composer.` : ""}</p> : null}

      <div className="settings-label">Path</div>
      <CommandPathField status={status} onSave={saveCommand} />
      {error ? <p className="settings-note" data-level="error">{error}</p> : null}
    </>
  );
}

/**
 * Codex's desktop half: it marks Codex threads and fills Codex's card on the
 * Providers page. The backend itself is the host entry.
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
        runtime: CODEX_BACKEND_KIND,
        order: 26,
        Component: (props: SettingsPageProps) => <CodexProviderCard {...props} host={plugin.host} />,
      }),
    ];
    return () => { for (const stop of stops) stop(); };
  },
};

export default codexExtension;
