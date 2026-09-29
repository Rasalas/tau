import { Suspense, lazy, useCallback, useEffect, useState, useSyncExternalStore, type ComponentProps } from "react";
import { Download, ExternalLink } from "lucide-react";
import { Button, SettingRow, SettingsState, TextField, loadRuntimeInstanceUi, loadSignInUi, useWorkbenchShell, type DesktopExtension, type HostExtensionClient, type RegionProps, type SettingsPageProps, type WorkbenchActions } from "tau";
import { ANTIGRAVITY_BACKEND_KIND, ANTIGRAVITY_HOST_EXTENSION_ID, ANTIGRAVITY_INSTALL_EVENT, ANTIGRAVITY_SIGN_IN_EVENT, type AntigravityInstallEvent, type AntigravitySignInEvent } from "./protocol.js";

/** The sign-in link the host half last reported; the composer notice opens it and offers it again. */
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
const CommandRow = lazy(() => loadRuntimeInstanceUi().then((module) => ({ default: module.RuntimeCommandRow })));
const CardBadge = lazy(() => loadRuntimeInstanceUi().then((module) => ({ default: module.ProviderCardBadgeReport })));
type ProviderCardBadge = NonNullable<ComponentProps<typeof CardBadge>["badge"]>;

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

/** Opens a requested Google sign-in link once, with a retry button above the composer. */
export function AntigravitySignInLink({ actions }: RegionProps) {
  const link = useSyncExternalStore(signInLinks.subscribe, signInLinks.getSnapshot);
  useEffect(() => {
    if (!link) return;
    actions.openExternal(link.url);
    actions.notify("Sign in with Google in your browser to continue with Antigravity.");
  }, [actions, link?.sequence]);
  if (!link) return null;
  return <button className="antigravity-sign-in" title="Open the Google sign-in link again" aria-label="Open the Google sign-in link" onClick={() => actions.openExternal(link.url)}><ExternalLink size={11} /> Sign in</button>;
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

/** The element ids of the card's rows. */
export const ROWS = {
  runtime: "setting-antigravity-runtime",
  account: "setting-antigravity-account",
  project: "setting-antigravity-gcp-project",
  location: "setting-antigravity-gcp-location",
  configuration: "setting-antigravity-configuration",
  executable: "setting-antigravity-executable",
} as const;

/** What the Settings search finds on the card. */
export const SEARCH_ROWS = [
  { id: ROWS.runtime, label: "Antigravity runtime", keywords: ["antigravity", "install", "update", "version", "agy_acp_server", "download"] },
  { id: ROWS.account, label: "Antigravity sign-in", keywords: ["google", "sign in", "sign out", "login", "gemini", "api key"] },
  { id: ROWS.project, label: "Google Cloud project", keywords: ["gcp", "gemini enterprise", "agent platform", "vertex"] },
  { id: ROWS.location, label: "Google Cloud location", keywords: ["gcp", "region", "us-central1"] },
  { id: ROWS.configuration, label: "Antigravity configuration", keywords: ["gemini", "skills", "mcp", "servers", "~/.gemini"] },
  { id: ROWS.executable, label: "Antigravity server executable", keywords: ["agy_acp_server", "path", "command"] },
];

/** The word the card's head shows for the runtime. */
function runtimeBadge(status: AntigravityStatusReport | undefined, outdated: boolean): ProviderCardBadge | undefined {
  if (!status) return undefined;
  if (status.installed) return outdated ? { label: "Update available", tone: "neutral" } : { label: "Installed", tone: "success" };
  return status.available === undefined ? { label: "Not available", tone: "neutral" } : { label: "Not installed", tone: "warn" };
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

  const installed = status?.installed === true;
  const outdated = installed && status?.source === "managed" && status.available !== undefined && status.version !== status.available;
  const label = installLabel(progress);
  const project = status?.gcpProject ?? "";
  const location = status?.gcpLocation ?? "";
  const waiting = status ? undefined : "Waiting for Antigravity's host half to answer.";

  return (
    <Suspense fallback={<SettingsState kind="loading" rows={3} title="Loading Antigravity" />}>
      <CardBadge source="program" badge={runtimeBadge(status, outdated)} />
      <SettingRow
        id={ROWS.runtime}
        title="Runtime"
        help="Gemini through Google's own agent. Tau downloads Google's Antigravity server, checks it against the release it expects, and runs it with the sign-in you choose below. A Google sign-in happens in that server, in your browser; Tau never sees a token."
        description={!status ? error ? "Tau could not ask Antigravity's host half." : "Checking…"
          : installed ? <>{status.version ? `${status.version} · ` : ""}{SOURCE_LABELS[status.source ?? ""] ?? status.source}{status.path ? <> · <code>{status.path}</code></> : null}</>
            : status.available === undefined ? "Google publishes no Antigravity runtime for this platform."
              : status.message ?? "Install it to open Antigravity threads."}
        status={(busy === "install" && label) || error ? <>
          {busy === "install" && label ? <p className="antigravity-progress" role="status">{label}</p> : null}
          {error ? <p className="antigravity-error" role="alert">{error}</p> : null}
        </> : undefined}
        control={status?.available && (!installed || outdated) ? (
          <Button icon={<Download size={13} aria-hidden />} busy={busy === "install"} onClick={() => void run("install", "Antigravity is installed.")}>
            {busy === "install" ? "Installing…" : installed ? `Update to ${status.available}` : `Install ${status.available}`}
          </Button>
        ) : undefined}
      />
      <SignIn
        host={host}
        program="Antigravity"
        heading="Sign-in"
        rowId={ROWS.account}
        openExternal={(url) => actions ? actions.openExternal(url) : void window.open(url, "_blank", "noopener")}
        copyText={(text) => actions?.copyText(text) ?? navigator.clipboard.writeText(text)}
        onNotify={onNotify}
        onReport={(next) => {
          if (next.flow?.phase === "succeeded" || !next.account?.signedIn) signInLinks.clear();
          void refresh();
        }}
      />
      <SettingRow
        id={ROWS.project}
        title="Google Cloud project"
        description="Where Gemini Enterprise and Agent Platform run; Agent Platform takes a key or your application default credentials instead."
        disabledReason={waiting}
        control={<TextField label="Google Cloud project" mono width="md" value={project} placeholder="e.g. acme-dev" onCommit={(next) => void saveProject(next.trim(), location)} />}
      />
      <SettingRow
        id={ROWS.location}
        title="Google Cloud location"
        description="The region of that project."
        disabledReason={waiting}
        control={<TextField label="Google Cloud location" mono width="md" value={location} placeholder="e.g. us-central1" onCommit={(next) => void saveProject(project, next.trim())} />}
      />
      <SettingRow
        id={ROWS.configuration}
        title="Your configuration"
        help="The agent runs with a Gemini home of Tau's own, so nothing it writes lands in yours. What passes through from ~/.gemini is your skills, linked into that home, and your MCP servers."
        description={`Your skills and MCP servers reach the agent. MCP servers: ${status?.mcpServers?.length ? status.mcpServers.join(", ") : "none configured"}.`}
      />
      <CommandRow
        id={ROWS.executable}
        program="Antigravity server"
        variable="TAU_ANTIGRAVITY_ACP_COMMAND"
        known={status !== undefined}
        {...(status?.command ? { command: status.command } : {})}
        {...(status?.commandSource ? { source: status.commandSource } : {})}
        placeholder="The server Tau installs"
        description="Google's agy_acp_server of your own. Empty uses the one Tau installs."
        onSave={saveCommand}
      />
    </Suspense>
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
      plugin.registerRegion({ id: "antigravity.sign-in", placement: "composer-above", order: 5, profiles: ["desktop", "web", "compact"], Component: AntigravitySignInLink }),
      plugin.registerSettingsPage({
        id: "antigravity.settings",
        label: "Antigravity",
        profiles: ["desktop", "web"],
        runtime: ANTIGRAVITY_BACKEND_KIND,
        order: 27,
        rows: SEARCH_ROWS,
        runtimeRows: { program: ROWS.runtime },
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
