import { Suspense, lazy, useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { CircleCheck, Download, ExternalLink, Orbit, TriangleAlert } from "lucide-react";
import { loadSignInUi, useWorkbenchShell, type DesktopExtension, type HostExtensionClient, type RegionProps, type SettingsPageProps, type WorkbenchActions } from "tau";
import { ANTIGRAVITY_BACKEND_KIND, ANTIGRAVITY_HOST_EXTENSION_ID, ANTIGRAVITY_INSTALL_EVENT, ANTIGRAVITY_SIGN_IN_EVENT, type AntigravityInstallEvent, type AntigravitySignInEvent } from "./protocol.js";

/** The sign-in link the host half last reported; the status item opens it and offers it again. */
export class SignInLinks {
  private link?: { url: string; sequence: number };
  private sequence = 0;
  private readonly listeners = new Set<() => void>();
  getSnapshot = (): { url: string; sequence: number } | undefined => this.link;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  report(url: string): void {
    this.link = { url, sequence: ++this.sequence };
    for (const listener of this.listeners) listener();
  }
  clear(): void {
    if (!this.link) return;
    this.link = undefined;
    for (const listener of this.listeners) listener();
  }
}

export const signInLinks = new SignInLinks();

const SignIn = lazy(() => loadSignInUi().then((module) => ({ default: module.SignInSetup })));

function useShellActions(): WorkbenchActions | undefined {
  try {
    return useWorkbenchShell().actions;
  } catch {
    return undefined;
  }
}

function isGoogleSignIn(url: unknown): url is string {
  return typeof url === "string" && url.startsWith("https://accounts.google.com/o/oauth2/v2/auth?");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Marks the runtime behind an Antigravity thread with an icon, and opens Google's sign-in link when the agent asks for one. */
export function AntigravityStatus({ snapshot, actions }: RegionProps) {
  const link = useSyncExternalStore(signInLinks.subscribe, signInLinks.getSnapshot);
  // Every reported link is opened once; the button below re-opens it.
  useEffect(() => {
    if (!link) return;
    actions.openExternal(link.url);
    actions.notify("Sign in with Google in your browser to continue with Antigravity.");
  }, [actions, link?.sequence]);
  if (snapshot?.backendKind !== ANTIGRAVITY_BACKEND_KIND && !link) return null;
  const model = snapshot?.model?.name;
  return (
    <span className="status-item" title={`Antigravity: this thread runs Google's Antigravity agent through the Agent Client Protocol${model ? ` on ${model}` : ""}.`}>
      <Orbit size={12} role="img" aria-label="Antigravity" />
      {link ? <button className="antigravity-sign-in" title="Open the Google sign-in link again" aria-label="Open the Google sign-in link" onClick={() => actions.openExternal(link.url)}><ExternalLink size={11} /> Sign in</button> : null}
    </span>
  );
}

export interface AntigravityStatusReport {
  installed: boolean;
  /** The server's path when one was named, and by whom; absent for Tau's own install or the PATH. */
  command?: string;
  commandSource?: "env" | "setting";
  source?: "override" | "managed" | "path";
  version?: string;
  path?: string;
  signedIn?: boolean;
  authMethod?: string;
  gcpProject?: string;
  gcpLocation?: string;
  available?: string;
  mcpServers?: string[];
  models?: number;
  message?: string;
}

const SOURCE_LABELS: Record<string, string> = {
  managed: "downloaded by Tau",
  override: "the path set below",
  path: "found on your PATH",
};

function installLabel(event: AntigravityInstallEvent | undefined): string | undefined {
  if (!event) return undefined;
  if (event.phase === "downloading") {
    const total = event.totalBytes ?? 0;
    const done = event.downloadedBytes ?? 0;
    const percent = total > 0 ? Math.floor((done / total) * 100) : 0;
    return `Downloading ${percent}% (${Math.round(done / (1024 * 1024))} of ${Math.round(total / (1024 * 1024))} MB)`;
  }
  if (event.phase === "extracting") return "Extracting…";
  if (event.phase === "verifying") return "Verifying…";
  return event.message;
}

/** The server's path, saved when the field is left or Enter is pressed; empty goes back to Tau's own install. */
function CommandPathField({ status, onSave }: { status: AntigravityStatusReport | undefined; onSave(command: string): Promise<void> }) {
  const saved = status?.commandSource === "setting" ? status.command ?? "" : "";
  const [draft, setDraft] = useState(saved);
  useEffect(() => { setDraft(saved); }, [saved]);
  const fromEnv = status?.commandSource === "env";
  const commit = () => { if (draft.trim() !== saved) void onSave(draft.trim()); };
  return (
    <>
      <input
        className="settings-search-input antigravity-path"
        aria-label="Antigravity server executable"
        value={fromEnv ? status!.command ?? "" : draft}
        placeholder="The server Tau installs"
        disabled={fromEnv || !status}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => { if (event.key === "Enter") commit(); }}
      />
      <p className="settings-note">{fromEnv ? <>Set by <code>TAU_ANTIGRAVITY_ACP_COMMAND</code> in Tau's environment.</> : <>Google's <code>agy_acp_server</code> of your own; leave it empty to use the one Tau installs.</>}</p>
    </>
  );
}

/** The Google Cloud project and location Enterprise and Agent Platform run in; saved when a field is left. */
function ProjectFields({ status, onSave }: { status: AntigravityStatusReport | undefined; onSave(project: string, location: string): Promise<void> }) {
  const [project, setProject] = useState(status?.gcpProject ?? "");
  const [location, setLocation] = useState(status?.gcpLocation ?? "");
  useEffect(() => { setProject(status?.gcpProject ?? ""); setLocation(status?.gcpLocation ?? ""); }, [status?.gcpProject, status?.gcpLocation]);
  const commit = () => {
    if (project.trim() !== (status?.gcpProject ?? "") || location.trim() !== (status?.gcpLocation ?? "")) void onSave(project.trim(), location.trim());
  };
  return (
    <div className="antigravity-project">
      <input className="settings-search-input" aria-label="Google Cloud project" placeholder="Google Cloud project, e.g. acme-dev" value={project} disabled={!status} onChange={(event) => setProject(event.target.value)} onBlur={commit} onKeyDown={(event) => { if (event.key === "Enter") commit(); }} />
      <input className="settings-search-input" aria-label="Google Cloud location" placeholder="Location, e.g. us-central1" value={location} disabled={!status} onChange={(event) => setLocation(event.target.value)} onBlur={commit} onKeyDown={(event) => { if (event.key === "Enter") commit(); }} />
    </div>
  );
}

/** Antigravity's card on the Providers page: where the runtime comes from, whether it is signed in, and what of the user's own configuration reaches it. */
export function AntigravityProviderCard({ onNotify, host }: SettingsPageProps & { host: HostExtensionClient }) {
  const [status, setStatus] = useState<AntigravityStatusReport>();
  const [busy, setBusy] = useState<"install">();
  const actions = useShellActions();
  const [progress, setProgress] = useState<AntigravityInstallEvent>();
  const [error, setError] = useState<string>();

  const refresh = useCallback(async () => {
    try {
      setStatus(await host.invoke("status") as AntigravityStatusReport);
    } catch (failure) {
      setError(errorMessage(failure));
    }
  }, [host]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => host.onEvent(ANTIGRAVITY_INSTALL_EVENT, (payload) => setProgress(payload as AntigravityInstallEvent)), [host]);

  const saveCommand = async (command: string) => {
    setError(undefined);
    try {
      await host.invoke("set-command", { command });
      onNotify(command ? `Antigravity runs from ${command}.` : "Antigravity runs the server Tau installs.");
      await refresh();
    } catch (failure) {
      setError(errorMessage(failure));
    }
  };

  const saveProject = async (gcpProject: string, gcpLocation: string) => {
    setError(undefined);
    try {
      await host.invoke("set-sign-in", { gcpProject, gcpLocation });
      await refresh();
    } catch (failure) {
      setError(errorMessage(failure));
    }
  };

  const run = async (command: "install", done: string) => {
    setBusy(command);
    setError(undefined);
    setProgress(undefined);
    try {
      await host.invoke(command);
      onNotify(done);
      await refresh();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(undefined);
    }
  };

  // Until the host half has answered, the page knows nothing and says so.
  const known = status !== undefined;
  const installed = status?.installed === true;
  const outdated = installed && status?.source === "managed" && status.available !== undefined && status.version !== status.available;
  const label = installLabel(progress);

  return (
    <>
      <p className="settings-note">
        Gemini through Google's own agent. Tau downloads Google's Antigravity server, checks it against the release it
        expects, and runs it with the sign-in you choose below. A Google sign-in happens in that server, in your
        browser; Tau never sees a token.
      </p>

      <div className="settings-label">Runtime</div>
      <div className="settings-field antigravity-field">
        {installed ? <CircleCheck size={14} className="accent" /> : <TriangleAlert size={14} />}
        <span>
          <strong>{!known ? "Checking…" : installed ? `Installed${status.version ? ` · ${status.version}` : ""}` : "Not installed"}</strong>
          <small>{!known ? "" : installed ? `${SOURCE_LABELS[status.source ?? ""] ?? status.source}${status.path ? ` · ${status.path}` : ""}` : status.message ?? "Install it to open Antigravity threads."}</small>
        </span>
        {status?.available && (!installed || outdated) ? (
          <button className="antigravity-action" disabled={busy !== undefined} onClick={() => void run("install", "Antigravity is installed.")}>
            <Download size={13} /> {busy === "install" ? "Installing…" : installed ? `Update to ${status.available}` : `Install ${status.available}`}
          </button>
        ) : null}
      </div>
      {busy === "install" && label ? <p className="settings-note" role="status">{label}</p> : null}
      {known && status.available === undefined ? <p className="settings-note">Google publishes no Antigravity runtime for this platform.</p> : null}

      <Suspense fallback={null}>
        <SignIn
          host={host}
          program="Antigravity"
          heading="Sign-in"
          openExternal={(url) => actions ? actions.openExternal(url) : void window.open(url, "_blank", "noopener")}
          copyText={(text) => actions?.copyText(text) ?? navigator.clipboard.writeText(text)}
          onNotify={onNotify}
          onReport={(next) => {
            if (next.flow?.phase === "succeeded" || !next.account?.signedIn) signInLinks.clear();
            void refresh();
          }}
        />
      </Suspense>
      <p className="settings-note">Gemini Enterprise and Agent Platform run in a Google Cloud project; Agent Platform takes a key or your application default credentials instead.</p>
      <ProjectFields status={status} onSave={saveProject} />

      <div className="settings-label">Your configuration</div>
      <p className="settings-note">
        The agent runs with a Gemini home of Tau's own, so nothing it writes lands in yours. What Tau does pass through
        from <code>~/.gemini</code> is your skills, linked into that home, and your MCP servers:{" "}
        {status?.mcpServers?.length ? status.mcpServers.join(", ") : "none configured"}.
      </p>

      <div className="settings-label">Path</div>
      <CommandPathField status={status} onSave={saveCommand} />
      {error ? <p className="settings-note" data-level="error">{error}</p> : null}
    </>
  );
}

/**
 * Antigravity's desktop half: marks its threads, opens the Google sign-in link
 * the host half reports, and fills its card on the Providers page: the runtime
 * and the account.
 */
export const antigravityExtension: DesktopExtension = {
  id: ANTIGRAVITY_HOST_EXTENSION_ID,
  name: "Antigravity",
  activate(plugin) {
    const stops = [
      plugin.registerStatusItem({ id: "antigravity.runtime", align: "left", order: 41, profiles: ["desktop", "web", "compact"], Component: AntigravityStatus }),
      plugin.registerSettingsPage({
        id: "antigravity.settings",
        label: "Antigravity",
        profiles: ["desktop", "web"],
        runtime: ANTIGRAVITY_BACKEND_KIND,
        order: 27,
        Component: (props: SettingsPageProps) => <AntigravityProviderCard {...props} host={plugin.host} />,
      }),
      plugin.host.onEvent(ANTIGRAVITY_SIGN_IN_EVENT, (payload) => {
        const event = payload as Partial<AntigravitySignInEvent> | undefined;
        if (isGoogleSignIn(event?.url)) signInLinks.report(event.url);
      }),
      // A settled turn means the sign-in went through; the link is spent.
      plugin.events.on("agent-status", () => signInLinks.clear()),
    ];
    return () => { for (const stop of stops) stop(); };
  },
};

export default antigravityExtension;
