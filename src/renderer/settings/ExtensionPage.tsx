import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentType } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, Settings2, Sparkles, X } from "lucide-react";
import type { ExtensionInspection, HostExtensionSummary, UiModel } from "../../shared/contracts";
import type { ExtensionRegistry, ExtensionSummary, SettingsSectionProps } from "../extension-system";
import { NETWORK_ADVISORY_NOTE, PERMISSION_NOTES, type ExtensionPermission } from "../../shared/extension-permissions";
import { usePreferences } from "../renderer-services-context";
import { useHostClient } from "../host-client-context";
import { useHostCapabilities } from "../use-host-capabilities";
import { ModelPicker, modelKey } from "../components/ModelPicker";
import { PanelIcon, type PanelIconComponent } from "../components/PanelIcon";
import { ProviderIconStack } from "../components/ProviderIconStack";
import { tooltipProps } from "../components/ui/Tooltip";
import { loadSharedIcons } from "../runtime-extensions";
import { Badge, Button, Select, SettingsState, Switch, ValueList, type ValueListItem } from "./controls";
import { extensionBlurb, stateLabel, type ExtensionEntry } from "./extension-catalog";
import { SettingRow, SettingsSection } from "./settings-layout";

/** Each permission in the words of what it lets a package do. */
const PERMISSION_TITLES: Readonly<Record<ExtensionPermission, string>> = {
  "workspace:read": "Read the project's files",
  "workspace:write": "Change the project's files",
  "workspace:switch": "Open another project",
  sessions: "Read and write threads",
  "runtime:extend": "Give agents new tools and behaviour",
  process: "Start programs on this machine",
  network: "Reach the network",
  packages: "Install and remove extension packages",
  machines: "Work on your other machines",
  native: "Load compiled code into the host",
};

export function permissionTitle(permission: string): string {
  return PERMISSION_TITLES[permission as ExtensionPermission] ?? permission;
}

/** A model choice an extension declared; empty means the thread's own model. */
function ModelOptionRow({ label, value, models, disabled, onChange }: {
  label: string;
  value?: string;
  models: readonly UiModel[];
  disabled: boolean;
  onChange(value: string): void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerAnchor = useRef<HTMLButtonElement>(null);
  const chosen = value ? models.find((model) => modelKey(model) === value) : undefined;
  return (
    <div className="settings-row-inline">
      <button ref={pickerAnchor} type="button" className="settings-model-button" disabled={disabled} aria-label={`${label}: ${chosen?.name ?? "the thread's model"}`} onClick={() => setPickerOpen((open) => !open)}>
        <Sparkles size={14} className="accent" />
        <span>{chosen?.name ?? (value || "Thread's model")}</span>
        <ChevronDown size={14} aria-hidden />
      </button>
      {value ? (
        <button type="button" className="tau-icon-button" disabled={disabled} aria-label={`Use the thread's model for ${label}`} {...tooltipProps("Use the thread's model")} onClick={() => onChange("")}>
          <X size={14} />
        </button>
      ) : null}
      {pickerOpen ? (
        <ModelPicker models={models} activeKey={value} onSelect={(model) => onChange(modelKey(model))} onClose={() => setPickerOpen(false)} anchor={pickerAnchor} side="bottom" />
      ) : null}
    </div>
  );
}

/**
 * Packages on disk the user has not answered for yet. A host-only package has no
 * desktop half in the registry, so without this it would never reach the approval UI.
 */
export function useAwaitingApproval(cwd: string | undefined, known: readonly ExtensionSummary[], revision: number): ExtensionSummary[] {
  const client = useHostClient();
  const [packages, setPackages] = useState<ExtensionInspection["packages"]>([]);
  useEffect(() => {
    if (!cwd) return;
    let cancelled = false;
    client?.inspectExtensions(cwd).then((result) => { if (!cancelled) setPackages(result.packages); }).catch(() => undefined);
    return () => { cancelled = true; };
    // `revision` moves when an answer was given, so an approved package leaves the list.
  }, [client, cwd, revision]);
  const knownIds = known.map((entry) => entry.id).join("\u0000");
  return useMemo(() => {
    const ids = new Set(knownIds ? knownIds.split("\u0000") : []);
    return packages
      .filter((pkg) => pkg.granted === false && !ids.has(pkg.id))
      .map((pkg) => ({
        id: pkg.id,
        name: pkg.name,
        active: false,
        contributes: "",
        options: [],
        permissions: pkg.permissions ?? [],
        ...(pkg.isolation ? { isolation: pkg.isolation } : {}),
        granted: false,
      }));
  }, [knownIds, packages]);
}

export interface ExtensionSources {
  inspection?: ExtensionInspection;
  hostHalves: HostExtensionSummary[];
  /** Why the package folders could not be read. */
  error?: string;
  loading: boolean;
  refresh(): void;
  setHostHalves(halves: HostExtensionSummary[]): void;
}

/** The last answers, so Settings opened again draws at once and reads again underneath. */
const lastSources: { cwd?: string | undefined; inspection?: ExtensionInspection; hostHalves: HostExtensionSummary[] } = { hostHalves: [] };

/** What the host knows about extensions: its halves, and core's scan of the package folders. */
export function useExtensionSources(cwd: string | undefined, revision: number): ExtensionSources {
  const client = useHostClient();
  const [inspection, setInspection] = useState<ExtensionInspection | undefined>(() => (lastSources.cwd === cwd ? lastSources.inspection : undefined));
  const [hostHalves, setHostHalves] = useState<HostExtensionSummary[]>(() => lastSources.hostHalves);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(Boolean(client));
  const [round, setRound] = useState(0);
  useEffect(() => {
    if (!client) { setLoading(false); return undefined; }
    let cancelled = false;
    setLoading(true);
    const halves = client.listHostExtensions().then((summaries) => { lastSources.hostHalves = summaries; if (!cancelled) setHostHalves(summaries); }).catch(() => undefined);
    const scan = cwd
      ? client.inspectExtensions(cwd).then((result) => { Object.assign(lastSources, { cwd, inspection: result }); if (!cancelled) { setInspection(result); setError(undefined); } })
        .catch((failure: unknown) => { if (!cancelled) setError(failure instanceof Error ? failure.message : String(failure)); })
      : Promise.resolve();
    void Promise.all([halves, scan]).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [client, cwd, revision, round]);
  return {
    ...(inspection ? { inspection } : {}),
    hostHalves,
    ...(error ? { error } : {}),
    loading,
    refresh: useCallback(() => setRound((value) => value + 1), []),
    setHostHalves,
  };
}

/**
 * Turns an extension on or off: the choice goes to the host's list, which
 * every client follows; this client's desktop half and the host half switch
 * at once rather than waiting for that round trip.
 */
export function useExtensionSwitch(registry: ExtensionRegistry, onNotify: (message: string) => void, onHostHalves?: (halves: HostExtensionSummary[]) => void) {
  const client = useHostClient();
  const preferences = usePreferences();
  return (entry: ExtensionEntry, next: boolean) => {
    preferences.setExtensionEnabled(entry.id, next);
    registry.setActive(entry.id, next);
    if (entry.host) {
      client?.setHostExtensionActive(entry.id, next).then((halves) => onHostHalves?.(halves)).catch((error: unknown) => {
        onNotify(error instanceof Error ? error.message : String(error));
      });
    }
  };
}

/**
 * The glyph each extension shows, kept when it is turned off: the mark of the
 * runtime it runs threads on, else the icon of a page or panel it adds (on any
 * client, drawn here or not), else the icon its manifest names.
 */
export type ExtensionMark = { runtime: string } | { Icon: PanelIconComponent } | { iconName: string };

export function extensionMarks(registry: ExtensionRegistry, entries: readonly ExtensionEntry[] = []): ReadonlyMap<string, ExtensionMark> {
  const marks = new Map<string, ExtensionMark>();
  for (const [id, mark] of registry.getContributionMarks()) {
    if (mark.runtime) marks.set(id, { runtime: mark.runtime });
    else if (mark.Icon) marks.set(id, { Icon: mark.Icon });
  }
  for (const entry of entries) {
    if (marks.has(entry.id)) continue;
    if (entry.pkg?.icon) marks.set(entry.id, { iconName: entry.pkg.icon });
    // Part of Tau's window, with no package to name an icon.
    else if (entry.origin === "app") marks.set(entry.id, { Icon: Settings2 });
  }
  return marks;
}

let sharedIcons: Record<string, unknown> | undefined;

/** A Lucide icon by name, from the icon set packages share; its chunk loads the first time one is asked for. */
function useNamedIcon(name: string | undefined): PanelIconComponent | undefined {
  const [icons, setIcons] = useState(sharedIcons);
  useEffect(() => {
    if (!name || icons) return;
    let live = true;
    void loadSharedIcons().then((module) => {
      sharedIcons = module as Record<string, unknown>;
      if (live) setIcons(sharedIcons);
    }, () => undefined);
    return () => { live = false; };
  }, [name, icons]);
  const icon = name && icons ? icons[name] : undefined;
  return typeof icon === "function" || (typeof icon === "object" && icon !== null) ? icon as PanelIconComponent : undefined;
}

export function ExtensionGlyph({ name, mark, size = "md" }: { name: string; mark?: ExtensionMark | undefined; size?: "md" | "lg" }) {
  const Named = useNamedIcon(mark && "iconName" in mark ? mark.iconName : undefined);
  const Icon = mark && "Icon" in mark ? mark.Icon : Named;
  return (
    <span className="extension-glyph" data-size={size} aria-hidden>
      {mark && "runtime" in mark ? <ProviderIconStack runtimeProvider={mark.runtime} hint={false} />
        : Icon ? <PanelIcon Icon={Icon} size={size === "lg" ? 22 : 16} />
          : <b>{name.replace(/[^\p{L}\p{N}]/gu, "").slice(0, 1).toUpperCase() || "?"}</b>}
    </span>
  );
}

export function StateBadge({ entry }: { entry: ExtensionEntry }) {
  if (entry.state === "on") return null;
  const tone = entry.state === "off" ? "neutral" : entry.state === "waiting" ? "warn" : "danger";
  return <Badge tone={tone} dot={entry.state !== "off"}>{stateLabel(entry.state)}</Badge>;
}

function originText(entry: ExtensionEntry, distribution?: ExtensionInspection["distribution"]): string {
  if (entry.origin === "app") return "Part of Tau";
  if (entry.origin === "bundled") return distribution ? `Bundled with Tau (${distribution.name} ${distribution.version})` : "Bundled with Tau";
  const pkg = entry.pkg;
  const where = pkg?.scope === "project" ? "for this project" : "for every project";
  return pkg?.installedFrom ? `${pkg.installedFrom}, ${where}` : pkg?.source?.url ? `${pkg.source.url}, ${where}` : `Installed ${where}`;
}

/** The next step for an extension that does not run. */
function problemAdvice(entry: ExtensionEntry): string {
  if (entry.state === "incompatible") return "Update Tau, or install a version of the package made for this one.";
  if (entry.origin === "installed") return "Update the package, or turn it off and on again after fixing it; the host log has the details.";
  return "Turn it off and on again; if it fails again, the host log has the details.";
}

/**
 * Settings → Extensions → one extension: what it is, whether it runs and why
 * not, the settings it declared and the pages it adds, what it may do, where
 * it came from, and what other packages add (Packages Kit: update, remove).
 */
export function ExtensionPage({ entry, registry, models, cwd, distribution, sections = [], onOpen, onChanged, onNotify, onHostHalves }: {
  entry: ExtensionEntry;
  registry: ExtensionRegistry;
  models: readonly UiModel[];
  cwd?: string | undefined;
  distribution?: ExtensionInspection["distribution"];
  /** What packages add to an extension's page (`registerSettingsSection({ page: "extension" })`). */
  sections?: ReadonlyArray<{ id: string; Component: ComponentType<SettingsSectionProps> }>;
  onOpen(target: string): void;
  onChanged(): void;
  onNotify(message: string): void;
  onHostHalves(halves: HostExtensionSummary[]): void;
}) {
  const client = useHostClient();
  const preferences = usePreferences();
  const state = useSyncExternalStore(preferences.subscribe, preferences.getSnapshot);
  useSyncExternalStore(registry.subscribe, registry.getVersion);
  const toggle = useExtensionSwitch(registry, onNotify, onHostHalves);
  const { readOnly } = useHostCapabilities();
  const summary = entry.summary;
  const mark = extensionMarks(registry, [entry]).get(entry.id);
  const pages = registry.getSettingsPages().filter((page) => page.extensionId === entry.id && !page.standalone);
  const running = entry.state === "on";

  // A grant is the package's first start; a denial keeps both halves off. The
  // host starts or stops its own half and pushes the desktop half after it, so
  // a package approved here needs no reload.
  const answer = async (allow: boolean) => {
    try {
      preferences.setExtensionEnabled(entry.id, allow);
      await client?.grantExtension(entry.id, allow);
      registry.setGranted(entry.id, allow);
      registry.setActive(entry.id, allow);
      onHostHalves(await client?.listHostExtensions() ?? []);
      onChanged();
    } catch (error) {
      onNotify(error instanceof Error ? error.message : String(error));
    }
  };

  const isolation = entry.host?.isolation ?? entry.pkg?.isolation ?? summary?.isolation;
  const details: ValueListItem[] = [
    { label: "Version", value: entry.version ?? "Not declared", mono: Boolean(entry.version) },
    { label: "Source", value: originText(entry, distribution) },
    ...(entry.pkg?.signature ? [{ label: "Signature", value: entry.pkg.signature.label }] : []),
    ...(entry.pkg ? [{ label: "Parts", value: [entry.pkg.desktop ? "window" : "", entry.pkg.host ? "host" : "", entry.theme ? "stylesheet" : ""].filter(Boolean).join(" and ") || "none" }] : []),
    ...(summary?.contributes ? [{ label: "Adds", value: summary.contributes.split(" · ").join(", ") }] : []),
    ...(entry.pkg?.engines ? [{ label: "Needs", value: Object.entries(entry.pkg.engines).map(([engine, range]) => `${engine === "api" ? "extension API" : engine === "tau" ? "Tau" : "Pi"} ${range}`).join(", "), mono: true }] : []),
    { label: "ID", value: entry.id, mono: true, copy: entry.id },
    ...(entry.pkg && entry.origin === "installed" ? [{ label: "Folder", value: entry.pkg.directory, mono: true, copy: entry.pkg.directory }] : []),
  ];

  return (
    <div className="settings-page extension-page">
      <header className="extension-hero">
        <ExtensionGlyph name={entry.name} mark={mark} size="lg" />
        <div className="extension-hero-text">
          <h1>{entry.name}</h1>
          <p>{extensionBlurb(entry)}</p>
          <div className="extension-hero-badges">
            <StateBadge entry={entry} />
            <Badge>{entry.origin === "installed" ? "Installed" : entry.origin === "bundled" ? "Bundled" : "Part of Tau"}</Badge>
            {entry.version ? <Badge>{`v${entry.version}`}</Badge> : null}
            {entry.theme ? <Badge>Theme</Badge> : null}
          </div>
        </div>
        <div className="extension-hero-control">
          {entry.locked ? <Badge tone="accent">Always on</Badge>
            : entry.state === "waiting" || entry.state === "incompatible" ? null
              : <Switch label={`${running ? "Turn off" : "Turn on"} ${entry.name}`} checked={running || entry.state === "failed"} disabled={readOnly} onChange={(next) => { toggle(entry, next); onChanged(); }} />}
        </div>
      </header>

      {entry.state === "waiting" ? (
        <SettingsSection title="Approval">
          <div className="extension-approval">
            <p>{entry.name} does not run until you allow what it asks for.</p>
            {entry.permissions.length > 0 ? (
              <ul>
                {entry.permissions.map((permission) => {
                  const note = PERMISSION_NOTES[permission as ExtensionPermission];
                  return <li key={permission}><strong>{permissionTitle(permission)}</strong><code>{permission}</code>{note ? <small>{note}</small> : null}</li>;
                })}
              </ul>
            ) : <p className="extension-approval-quiet">It asks for no permissions.</p>}
            {isolation === "in-process" ? (
              <p className="extension-approval-warning" role="note"><AlertTriangle size={14} aria-hidden />It {NETWORK_ADVISORY_NOTE}, so it can reach the network, start programs and load compiled code whatever it asked for.</p>
            ) : (
              <p className="extension-approval-quiet">It runs in a worker of its own, where network access, programs and compiled code are refused without the matching permission.</p>
            )}
            <div className="extension-approval-actions">
              <Button variant="primary" onClick={() => void answer(true)}>Allow and turn on</Button>
              <Button onClick={() => void answer(false)}>Deny</Button>
            </div>
          </div>
        </SettingsSection>
      ) : null}

      {entry.state === "failed" || entry.state === "incompatible" ? (
        <div className="extension-problem" role="alert">
          <AlertTriangle size={16} aria-hidden />
          <div>
            <strong>{entry.state === "incompatible" ? "It does not run on this version of Tau" : "It failed to start"}</strong>
            <p>{entry.problem}</p>
            <p>{problemAdvice(entry)}</p>
          </div>
        </div>
      ) : null}

      {summary && (summary.options.length > 0 || pages.length > 0) ? (
        <SettingsSection title="Settings">
          {pages.map((page) => (
            <button key={page.id} type="button" className="extension-page-link" onClick={() => onOpen(page.runtime ? "providers" : page.id)}>
              <PanelIcon Icon={page.Icon} size={15} />
              <span>{page.runtime ? `${page.label} on Providers` : page.label}</span>
              <ChevronRight size={15} aria-hidden />
            </button>
          ))}
          {summary.options.map((option) => {
            const inert = !running ? "Turn the extension on to change its settings." : undefined;
            if (option.kind === "model") {
              return (
                <SettingRow key={option.id} title={option.label} disabledReason={inert} control={<ModelOptionRow
                  label={option.label}
                  value={state.extensionValues[`${entry.id}.${option.id}`] || undefined}
                  models={models}
                  disabled={!running}
                  onChange={(value) => preferences.setValue(entry.id, option.id, value)}
                />} />
              );
            }
            if (option.kind === "chips") {
              return <SettingRow key={option.id} title={option.label} control={<div className="chip-row">{option.values.map((value) => <Badge key={value}>{value}</Badge>)}</div>} />;
            }
            if (option.kind === "select") {
              const value = state.extensionValues[`${entry.id}.${option.id}`] || option.defaultValue;
              return (
                <SettingRow key={option.id} title={option.label} disabledReason={inert} control={
                  <Select label={option.label} value={value} options={option.values} onChange={(next) => preferences.setValue(entry.id, option.id, next)} />
                } />
              );
            }
            const checked = state.extensionOptions[`${entry.id}.${option.id}`] ?? option.defaultValue;
            return (
              <SettingRow key={option.id} title={option.label} disabledReason={inert} control={
                <Switch role="checkbox" label={option.label} checked={checked} onChange={(next) => preferences.setOption(entry.id, option.id, next)} />
              } />
            );
          })}
        </SettingsSection>
      ) : null}

      {entry.state !== "waiting" && (entry.permissions.length > 0 || isolation) ? (
        <SettingsSection title="What it may do">
          {entry.permissions.map((permission) => (
            <SettingRow key={permission} title={permissionTitle(permission)} description={PERMISSION_NOTES[permission as ExtensionPermission]} control={<code className="settings-value">{permission}</code>} />
          ))}
          {isolation ? (
            <SettingRow
              title={isolation === "in-process" ? "Runs inside the host process" : "Runs in a worker of its own"}
              description={isolation === "in-process" ? "Its permissions are a promise, not a fence: the host process cannot hold it to them." : "Network access, programs and compiled code are refused without the matching permission."}
            />
          ) : null}
          {entry.permissions.length === 0 ? <p className="settings-group-note">It asks for no permissions.</p> : null}
        </SettingsSection>
      ) : null}

      <SettingsSection title="Details" plain>
        <ValueList items={details} label={`Details of ${entry.name}`} />
      </SettingsSection>

      {sections.map(({ id, Component }) => <Component key={id} extensionId={entry.id} {...(cwd ? { cwd } : {})} onNotify={onNotify} onChanged={onChanged} />)}

      {entry.origin !== "installed" ? (
        <p className="settings-footnote">{entry.origin === "bundled" ? "It ships with Tau: turn it off here; it cannot be removed." : "It is part of Tau's window and always runs."}</p>
      ) : null}
    </div>
  );
}

/** Where an extension page goes while its sources load, or when the extension is gone. */
export function ExtensionPageFallback({ loading, onBack }: { loading: boolean; onBack(): void }) {
  return loading
    ? <div className="settings-page"><SettingsState kind="loading" rows={4} title="Loading the extension" /></div>
    : <div className="settings-page"><SettingsState kind="empty" title="This extension is not here any more" description="It may have been removed, or it belongs to a project that is not open." action={<Button onClick={onBack}>All extensions</Button>} /></div>;
}
