import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { ChevronRight, Copy, Download, ExternalLink, FileText, RefreshCw, Search, X } from "lucide-react";
import { LICENSES_FILE, unpackLicenses, type ThirdPartyLicense } from "../../shared/third-party-licenses";
import { defaultUpdateChannel, isUpdateChannel, type UpdateChannel } from "../../shared/app-version";
import { describeHostUpdate, hostUpdatePending, type HostUpdateStatus } from "../../shared/host-updates";
import { useHostClient } from "../host-client-context";
import { useHostUpdate } from "../machine-updates";
import { usePlatform } from "../platform-context";
import { useHostCapabilities } from "../use-host-capabilities";
import { tooltipProps } from "../components/ui/Tooltip";
import { errorMessage } from "../../workbench/error-message";
import { Button, SettingsState, Switch } from "./controls";
import { formatAgo } from "./connections-format";
import { SettingRow, SettingsSection, useSetting } from "./settings-layout";
import { settingAnchor } from "./settings-search";

type LicenseState = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; packages: ThirdPartyLicense[] };

/** The manifest the build wrote beside the page; relative, so the file window, the web client and the dev server all find it. */
export async function loadLicenses(fetchImpl: typeof fetch = fetch, base: string = document.baseURI): Promise<ThirdPartyLicense[]> {
  const response = await fetchImpl(new URL(LICENSES_FILE, base).toString());
  if (!response.ok) throw new Error(`The list of licenses did not load (${response.status}).`);
  return unpackLicenses(await response.json());
}

const noSubscription = () => () => undefined;
const BUSY = new Set(["checking", "downloading", "waiting", "installing"]);
const OS: Record<string, string> = { darwin: "macOS", linux: "Linux", win32: "Windows" };
const READ_ONLY = "Read only: this needs a device with Full access.";

/** `macOS, Apple silicon`: where the host's Tau runs. */
export function describeMachine(platform?: string, arch?: string): string | undefined {
  if (!platform) return undefined;
  const chip = platform === "darwin" && arch ? (arch === "arm64" ? "Apple silicon" : "Intel") : arch;
  return [OS[platform] ?? platform, chip].filter(Boolean).join(", ");
}

function actionLabel(status: HostUpdateStatus): string {
  switch (status.phase) {
    case "checking": return "Checking…";
    case "downloading": return status.progress !== undefined ? `Downloading ${status.progress}%` : "Downloading…";
    case "waiting": return "Waiting for turns…";
    case "installing": return "Installing…";
    default: return hostUpdatePending(status) ? "Update now" : "Check now";
  }
}

/**
 * Settings → About (design 2k): which Tau the host runs and how it updates,
 * the same for a window, a browser and a phone (K103), and what it ships.
 */
export function AboutPage({ loader = loadLicenses }: { loader?: () => Promise<ThirdPartyLicense[]> }) {
  const client = useHostClient();
  const platform = usePlatform();
  useSyncExternalStore(client?.onVersions ?? noSubscription, () => JSON.stringify(client?.getVersions() ?? {}));
  const versions = client?.getVersions() ?? {};
  const { status, unavailable, store } = useHostUpdate();
  // The updater reads this machine's config; a host elsewhere would store a channel nothing here applies.
  const { localFiles: here } = useHostCapabilities();
  const channel = useSetting<UpdateChannel>("updates.channel", {
    defaultValue: defaultUpdateChannel(versions.window ?? versions.host), read: (raw) => (isUpdateChannel(raw) ? raw : undefined),
    format: (value) => (value === "nightly" ? "Nightly" : "Stable"),
  });
  const [showLicenses, setShowLicenses] = useState(false);
  const [licenses, setLicenses] = useState<LicenseState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState<string>();
  const [problem, setProblem] = useState<string>();
  const [asking, setAsking] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!showLicenses) return;
    let live = true;
    setLicenses({ status: "loading" });
    loader().then(
      (packages) => { if (live) setLicenses({ status: "ready", packages }); },
      (error: unknown) => { if (live) setLicenses({ status: "error", message: errorMessage(error) }); },
    );
    return () => { live = false; };
  }, [loader, attempt, showLicenses]);

  const query = filter.trim().toLowerCase();
  const shown = useMemo(() => licenses.status !== "ready" ? [] : licenses.packages.filter((entry) =>
    !query || entry.name.toLowerCase().includes(query) || entry.license.toLowerCase().includes(query)), [licenses, query]);

  const version = status?.version ?? versions.host ?? versions.window;
  const machine = client?.getHostName?.();
  const readOnly = client?.isReadOnly() === true;
  const unsupported = status?.phase === "unsupported";
  const pending = hostUpdatePending(status);
  const busy = asking || BUSY.has(status?.phase ?? "");
  const meta = [
    versions.window && versions.host && versions.window !== versions.host ? `this window ${versions.window}` : undefined,
    unsupported ? undefined : channel.format(status?.channel ?? channel.value),
    machine,
    describeMachine(status?.platform, status?.arch),
  ].filter(Boolean);
  const cannotInstall = readOnly ? READ_ONLY
    : pending && client?.isOwner?.() !== true && !status!.devicesMayInstall ? `${machine ?? "This machine"}'s owner lets only its own Tau window install updates.`
    : undefined;
  const run = (action: () => Promise<unknown>) => {
    setAsking(true);
    setProblem(undefined);
    action().catch((error: unknown) => setProblem(errorMessage(error))).finally(() => setAsking(false));
  };
  // A host too old for its own updater leaves the window's check.
  const oldHost = !status && unavailable !== undefined;
  const windowCheck = oldHost && versions.window;
  const line = status
    ? `${describeHostUpdate(status)}${unsupported || !status.checkedAt ? "" : ` Checked ${formatAgo(new Date(status.checkedAt).toISOString(), Date.now())}.`}`
    : windowCheck ? "An installed Tau checks every hour and after start." : undefined;
  const diagnostics = () => [
    `Tau ${version ?? "unknown"}${meta.length ? ` (${meta.join(", ")})` : ""}`,
    ...(line ? [`Updates: ${line}`] : []),
    `Client: ${navigator.userAgent}`,
  ].join("\n");

  return (
    <div className="settings-page about-page">
      <div className="about-hero" id={settingAnchor("Version")}>
        <svg className="about-mark" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="8" /><path d="M8.7 10h13.82M15 10v9.15c0 2.14 1.74 3.88 3.88 3.88 1.45 0 2.16-.4 3.15-1.09" /></svg>
        <div className="about-hero-text">
          <div><strong>{version ?? "Unknown version"}</strong>{meta.length ? <span> · {meta.join(" · ")}</span> : null}</div>
          {line ? <p role="status">{line}</p> : null}
          {problem ? <p role="alert">{problem}</p> : null}
          <div className="about-links" id={settingAnchor("Check for updates")}>
            {status && !unsupported && status.phase !== "installed" ? (
              <span {...tooltipProps(cannotInstall)}>
                <Button
                  variant={pending && !busy ? "primary" : "ghost"}
                  icon={pending ? <Download size={12} /> : <RefreshCw size={12} />}
                  busy={busy}
                  disabled={busy || cannotInstall !== undefined}
                  onClick={() => run(() => (pending ? store!.install() : store!.check()))}
                >{asking && !BUSY.has(status.phase) ? (pending ? "Starting…" : "Checking…") : actionLabel(status)}</Button>
              </span>
            ) : windowCheck ? (
              <Button variant="ghost" icon={<RefreshCw size={12} />} onClick={() => { void client?.windowAction({ kind: "check-for-updates" }).catch(() => undefined); }}>Check now</Button>
            ) : null}
            {version ? <Button variant="ghost" icon={<ExternalLink size={12} />} onClick={() => platform.openExternal(`https://github.com/Rasalas/tau-releases/releases/tag/v${version}`)}>Release notes</Button> : null}
            <Button variant="ghost" icon={<Copy size={12} />} onClick={() => void (client ? client.copyText(diagnostics()) : navigator.clipboard.writeText(diagnostics())).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }, () => undefined)}>
              {copied ? "Copied" : "Copy diagnostics"}
            </Button>
            <Button variant="ghost" id={settingAnchor("Open-source licenses")} icon={<FileText size={12} />} aria-expanded={showLicenses} onClick={() => setShowLicenses(!showLicenses)}>Licenses</Button>
          </div>
        </div>
      </div>

      {(status && !unsupported) || (here && oldHost) ? (
        <div className="settings-group">
          {status && !unsupported ? (
            <SettingRow
              id={settingAnchor("Automatic updates")}
              title="Automatic updates"
              description={status.installer === "window" ? "Downloads on its own and installs on restart." : "Installs once no turn has run for 15 minutes."}
              disabledReason={readOnly ? READ_ONLY : undefined}
              control={<Switch label="Automatic updates" checked={status.automatic} disabled={readOnly} onChange={(automatic) => run(() => store!.setSettings({ automatic }))} />}
            />
          ) : null}
          {here ? (
            <SettingRow
              id={settingAnchor("Pre-release builds")}
              title="Pre-release builds"
              description="The nightly build of main instead of tagged releases."
              help="Turning it off returns to the latest release, even when it is older than the nightly build you have."
              setting={channel}
              control={<Switch label="Pre-release builds" checked={channel.value === "nightly"} onChange={(on) => channel.set(on ? "nightly" : "stable")} />}
            />
          ) : null}
          {status && !unsupported && client?.isOwner?.() === true ? (
            <SettingRow
              id={settingAnchor("Paired devices may update")}
              title="Paired devices may update this machine"
              description="Full access only; Read-only devices never can."
              control={<Switch label="Paired devices may update this machine" checked={status.devicesMayInstall} onChange={(devicesMayInstall) => run(() => store!.setSettings({ devicesMayInstall }))} />}
            />
          ) : null}
        </div>
      ) : null}

      {showLicenses ? (
        <SettingsSection title={licenses.status === "ready" ? `Open-source licenses (${licenses.packages.length})` : "Open-source licenses"}>
          {licenses.status === "ready" && licenses.packages.length > 0 ? (
            <label className="settings-filter about-licenses-filter">
              <Search size={14} aria-hidden />
              <input type="search" placeholder="Filter by package or licence…" aria-label="Filter licenses" value={filter} onChange={(event) => setFilter(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Escape" && filter) { event.preventDefault(); event.stopPropagation(); setFilter(""); } }} />
              {filter ? <button type="button" className="tau-icon-button" aria-label="Clear the filter" onClick={() => setFilter("")}><X size={13} /></button> : null}
            </label>
          ) : null}
          {licenses.status === "loading" ? (
            <SettingsState kind="loading" title="Reading the licenses" rows={3} />
          ) : licenses.status === "error" ? (
            <SettingsState kind="error" title="The licenses are not available" description={licenses.message} onRetry={() => setAttempt((count) => count + 1)} />
          ) : licenses.packages.length === 0 ? (
            <SettingsState kind="empty" title="No licenses listed" description="The list this build carries names no package." />
          ) : shown.length === 0 ? (
            <SettingsState kind="empty" title={`No package matches “${filter.trim()}”`} description="Filter by a package's name or its licence." action={<Button onClick={() => setFilter("")}>Clear the filter</Button>} />
          ) : (
            <ul className="about-licenses" aria-label="Open-source licenses">
              {shown.map((entry) => {
                const key = `${entry.name}@${entry.version}`;
                const expanded = open === key;
                return (
                  <li key={key}>
                    <div className="about-license-row">
                      <button type="button" className="about-license-toggle" aria-expanded={expanded} onClick={() => setOpen(expanded ? undefined : key)}>
                        <ChevronRight size={13} aria-hidden="true" />
                        <strong>{entry.name}</strong>
                        <code>{entry.version}</code>
                        <small>{entry.license}</small>
                      </button>
                      {entry.repository ? (
                        <button type="button" className="tau-icon-button" aria-label={`Project source of ${entry.name}`} {...tooltipProps("Project source")} onClick={() => platform.openExternal(entry.repository!)}>
                          <ExternalLink size={13} />
                        </button>
                      ) : <span className="about-license-no-source" aria-hidden />}
                    </div>
                    {expanded ? <pre className="about-license-text">{entry.text ?? `${entry.name} ships no licence file; its package names ${entry.license}.`}</pre> : null}
                  </li>
                );
              })}
            </ul>
          )}
        </SettingsSection>
      ) : null}
    </div>
  );
}
