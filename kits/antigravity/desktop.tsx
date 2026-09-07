import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { CircleCheck, Download, ExternalLink, Orbit, TriangleAlert } from "lucide-react";
import type { DesktopExtension, HostExtensionClient, RegionProps, SettingsPageProps } from "tau";
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

function isGoogleSignIn(url: unknown): url is string {
  return typeof url === "string" && url.startsWith("https://accounts.google.com/o/oauth2/v2/auth?");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Names the runtime behind an Antigravity thread, and opens Google's sign-in link when the agent asks for one. */
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
    <span className="status-item" title={`This thread runs Google's Antigravity agent through the Agent Client Protocol${model ? ` on ${model}` : ""}.`}>
      <Orbit size={12} /> Antigravity
      {link ? <button className="antigravity-sign-in" title="Open the Google sign-in link again" aria-label="Open the Google sign-in link" onClick={() => actions.openExternal(link.url)}><ExternalLink size={11} /> Sign in</button> : null}
    </span>
  );
}

export interface AntigravityStatusReport {
  installed: boolean;
  source?: "override" | "managed" | "path";
  version?: string;
  path?: string;
  signedIn?: boolean;
  available?: string;
  mcpServers?: string[];
  models?: number;
  message?: string;
}

const SOURCE_LABELS: Record<string, string> = {
  managed: "downloaded by Tau",
  override: "TAU_ANTIGRAVITY_ACP_COMMAND",
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

/** Where the runtime comes from, whether it is signed in, and what of the user's own configuration reaches it. */
export function AntigravitySettingsPage({ onNotify, host }: SettingsPageProps & { host: HostExtensionClient }) {
  const [status, setStatus] = useState<AntigravityStatusReport>();
  const [busy, setBusy] = useState<"install" | "logout">();
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

  const run = async (command: "install" | "logout", done: string) => {
    setBusy(command);
    setError(undefined);
    setProgress(undefined);
    try {
      await host.invoke(command);
      onNotify(done);
      if (command === "logout") signInLinks.clear();
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
    <div className="settings-page">
      <h3>Antigravity</h3>
      <p className="lede">
        Gemini through Google's own agent. Tau downloads Google's Antigravity server, checks it against the release it
        expects, and runs it with your Google account. The sign-in happens in that server, in your browser; Tau never
        sees a token.
      </p>

      <div className="settings-label">RUNTIME</div>
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

      <div className="settings-label">GOOGLE ACCOUNT</div>
      <div className="settings-field antigravity-field">
        {status?.signedIn ? <CircleCheck size={14} className="accent" /> : <TriangleAlert size={14} />}
        <span>
          <strong>{!known ? "Checking…" : status.signedIn ? "Signed in" : "Not signed in"}</strong>
          <small>{status?.signedIn ? "The agent holds your Google credentials in Tau's own profile folder." : "The first turn of an Antigravity thread opens Google's sign-in in your browser."}</small>
        </span>
        {status?.signedIn ? (
          <button className="antigravity-action" disabled={busy !== undefined} onClick={() => void run("logout", "Signed out of Antigravity.")}>
            {busy === "logout" ? "Signing out…" : "Sign out"}
          </button>
        ) : null}
      </div>

      <div className="settings-label">YOUR CONFIGURATION</div>
      <p className="settings-note">
        The agent runs with a Gemini home of Tau's own, so nothing it writes lands in yours. What Tau does pass through
        from <code>~/.gemini</code> is your skills, linked into that home, and your MCP servers:{" "}
        {status?.mcpServers?.length ? status.mcpServers.join(", ") : "none configured"}.
      </p>
      {error ? <p className="settings-note" data-level="error">{error}</p> : null}
    </div>
  );
}

/**
 * Antigravity's desktop half: marks its threads, opens the Google sign-in link
 * the host half reports, and owns the Settings page for the runtime and the
 * account.
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
        Icon: Orbit,
        order: 26,
        Component: (props: SettingsPageProps) => <AntigravitySettingsPage {...props} host={plugin.host} />,
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
