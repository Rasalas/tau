import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { ChevronDown, Command, Plus, Puzzle, Sliders, Sparkles, X } from "lucide-react";
import type { ExtensionInspection, HostExtensionSummary, HostSnapshot, UiModel } from "../../shared/contracts";
import type { ExtensionRegistry, ExtensionSummary } from "../extension-system";
import { NETWORK_ADVISORY_NOTE, PERMISSION_NETWORK } from "../../shared/extension-permissions";
import { TRANSCRIPT_DETAIL_LEVELS } from "../../workbench/transcript-folding";
import { THEME_PREFERENCES } from "../theme";
import { usePreferences } from "../renderer-services-context";
import { effectiveNewThreadRuntime } from "../new-thread-runtime";
import { useHostClient } from "../host-client-context";
import { ModelPicker, modelKey } from "./ModelPicker";
import { PackageProvenance } from "./PackageProvenance";
import { PanelIcon } from "./PanelIcon";

function DefaultsPage({
  snapshot,
  onSetModel,
  onSetThinking,
}: {
  snapshot?: HostSnapshot;
  onSetModel(provider: string, id: string): void;
  onSetThinking(level: string): void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const preferences = usePreferences();
  const { showCosts, transcriptDetail, theme, newThreadRuntime: runtimePreference } = useSyncExternalStore(preferences.subscribe, preferences.getSnapshot);
  const newThreadRuntime = effectiveNewThreadRuntime(runtimePreference, snapshot);

  return (
    <div className="settings-page">
      <h3>Defaults</h3>
      <p className="lede">Seed for new threads — override any of these per thread in the composer.</p>

      <div className="settings-label">MODEL</div>
      <button className="settings-field" onClick={() => setPickerOpen(true)}>
        <Sparkles size={14} className="accent" />
        <span>
          <strong>{snapshot?.model?.name ?? "No model selected"}</strong>
          <small>{snapshot?.model?.provider ?? "pi"} · via ~/.pi/agent</small>
        </span>
        <b><ChevronDown size={13} /></b>
      </button>
      {pickerOpen ? (
        <ModelPicker
          models={snapshot?.models ?? []}
          activeKey={snapshot?.model ? modelKey(snapshot.model) : undefined}
          onSelect={(model) => onSetModel(model.provider, model.id)}
          onClose={() => setPickerOpen(false)}
        />
      ) : null}

      <div className="settings-label">THINKING</div>
      <div className="segmented">
        {(snapshot?.thinkingLevels ?? []).map((level) => (
          <button
            key={level}
            className={level === snapshot?.thinkingLevel ? "active" : ""}
            onClick={() => onSetThinking(level)}
          >
            {level}
          </button>
        ))}
      </div>

      {(snapshot?.runtimeBackends?.length ?? 0) > 1 ? (
        <>
          <div className="settings-label">RUNTIME</div>
          <div className="segmented" role="group" aria-label="Runtime for new threads">
            {(snapshot?.runtimeBackends ?? []).map((backend) => (
              <button
                key={backend.kind}
                className={backend.kind === newThreadRuntime ? "active" : ""}
                aria-pressed={backend.kind === newThreadRuntime}
                onClick={() => preferences.setNewThreadRuntime(backend.kind)}
              >
                {backend.label}
              </button>
            ))}
          </div>
          <p className="settings-note">Which program runs a new thread. Threads that already exist keep theirs, and the composer offers the same choice before the first message.</p>
        </>
      ) : null}

      <div className="settings-label">TRANSCRIPT DETAIL</div>
      <div className="segmented">
        {TRANSCRIPT_DETAIL_LEVELS.map((level) => (
          <button
            key={level}
            className={level === transcriptDetail ? "active" : ""}
            onClick={() => preferences.setTranscriptDetail(level)}
          >
            {level}
          </button>
        ))}
      </div>
      <p className="settings-note">
        Focused reads a settled turn as one line; detailed opens every group and shows thinking;
        everything adds full tool output and timestamps. ⇧⌘T cycles them for the thread on screen.
      </p>

      <div className="settings-label">APPEARANCE</div>
      <div className="segmented">
        {THEME_PREFERENCES.map((preference) => (
          <button
            key={preference}
            className={preference === theme ? "active" : ""}
            onClick={() => preferences.setTheme(preference)}
          >
            {preference}
          </button>
        ))}
      </div>
      <p className="settings-note">
        System follows this machine's light or dark setting. A theme package installed with
        <code> /install </code> recolours whichever of the two is showing.
      </p>

      <div className="settings-label">COSTS</div>
      <div className="settings-toggle-row">
        <span>
          <strong>Show costs</strong>
          <small>What each thread has spent, in the composer and the thread list.</small>
        </span>
        <button
          className={`switch ${showCosts ? "on" : ""}`}
          role="switch"
          aria-checked={showCosts}
          aria-label="Show costs"
          onClick={() => preferences.setShowCosts(!showCosts)}
        >
          <i />
        </button>
      </div>

    </div>
  );
}

/** A model choice an extension declared; empty means the thread's own model. */
function ModelOptionRow({
  label,
  value,
  models,
  disabled,
  onChange,
}: {
  label: string;
  value?: string;
  models: readonly UiModel[];
  disabled: boolean;
  onChange(value: string): void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const chosen = value ? models.find((model) => modelKey(model) === value) : undefined;
  return (
    <div className="model-option-row">
      <button className="settings-field" disabled={disabled} onClick={() => setPickerOpen(true)}>
        <Sparkles size={14} className="accent" />
        <span>
          <strong>{chosen?.name ?? (value || "Thread's model")}</strong>
          <small>{label}{chosen ? ` · ${chosen.provider}` : ""}</small>
        </span>
        <b><ChevronDown size={13} /></b>
      </button>
      {value ? (
        <button className="model-option-clear" disabled={disabled} aria-label={`Use the thread's model for ${label}`} onClick={() => onChange("")}>
          <X size={12} />
        </button>
      ) : null}
      {pickerOpen ? (
        <ModelPicker
          models={models}
          activeKey={value}
          onSelect={(model) => onChange(modelKey(model))}
          onClose={() => setPickerOpen(false)}
        />
      ) : null}
    </div>
  );
}

/**
 * Packages on disk the user has not answered for yet. A host-only package has no
 * desktop half in the registry, so without this it would never reach the approval UI.
 */
function useAwaitingApproval(cwd: string | undefined, known: readonly ExtensionSummary[], revision: number): ExtensionSummary[] {
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

function ExtensionPage({
  summary,
  registry,
  models,
  cwd,
  onChanged,
  onNotify,
}: {
  summary: ExtensionSummary;
  registry: ExtensionRegistry;
  models: readonly UiModel[];
  cwd?: string;
  onChanged(): void;
  onNotify(message: string): void;
}) {
  const client = useHostClient();
  const preferences = usePreferences();
  const state = useSyncExternalStore(preferences.subscribe, preferences.getSnapshot);
  // The host half of the same package, if the package has one.
  const [hostHalves, setHostHalves] = useState<HostExtensionSummary[]>([]);
  useEffect(() => {
    let cancelled = false;
    client?.listHostExtensions().then((summaries) => { if (!cancelled) setHostHalves(summaries); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [client, summary.id]);
  const hostHalf = hostHalves.find((entry) => entry.id === summary.id);

  const toggleExtension = () => {
    const next = !summary.active;
    preferences.setExtensionEnabled(summary.id, next);
    registry.setActive(summary.id, next);
    if (hostHalf) {
      client?.setHostExtensionActive(summary.id, next).then(setHostHalves).catch((error: unknown) => {
        onNotify(error instanceof Error ? error.message : String(error));
      });
    }
    onChanged();
  };

  // A grant is the package's first start; a denial keeps both halves off. The
  // host starts or stops its own half and pushes the desktop half after it, so
  // a package approved here needs no reload.
  const handleGrant = async (allow: boolean) => {
    try {
      preferences.setExtensionEnabled(summary.id, allow);
      await client?.grantExtension(summary.id, allow);
      registry.setGranted(summary.id, allow);
      registry.setActive(summary.id, allow);
      setHostHalves(await client?.listHostExtensions() ?? []);
      onChanged();
    } catch (error) {
      onNotify(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div className="settings-page">
      <div className="extension-head">
        <span>
          <strong>{summary.name}</strong>
          <small>
            {summary.granted === false
              ? "waiting for approval"
              : summary.contributes
                ? `contributes ${summary.contributes}`
                : "no contributions"}
          </small>
        </span>
        {summary.granted === false || summary.core ? null : (
          <button
            className={`switch ${summary.active ? "on" : ""}`}
            role="switch"
            aria-checked={summary.active}
            aria-label={`${summary.active ? "Disable" : "Enable"} ${summary.name}`}
            onClick={toggleExtension}
          >
            <i />
          </button>
        )}
      </div>

      {summary.granted === false ? (
        <div className="extension-grant-box">
          <div className="settings-label">APPROVAL REQUIRED</div>
          <p>This package does not run until you approve what it asks for:</p>
          {summary.permissions && summary.permissions.length > 0 ? (
            <ul>{summary.permissions.map((permission) => <li key={permission}><code>{permission}</code></li>)}</ul>
          ) : (
            <p>It asks for no permissions.</p>
          )}
          {summary.isolation === "in-process" ? (
            <>
              <ul><li><code>in-process</code> — runs inside the host process, outside the worker isolation</li></ul>
              {summary.permissions?.includes(PERMISSION_NETWORK) ? null : (
                <p className="settings-note">{NETWORK_ADVISORY_NOTE}, so this package can reach the network without asking.</p>
              )}
            </>
          ) : null}
          <div className="extension-grant-actions">
            <button type="button" className="grant-allow" onClick={() => void handleGrant(true)}>Allow</button>
            <button type="button" className="grant-deny" onClick={() => void handleGrant(false)}>Deny</button>
          </div>
        </div>
      ) : null}

      {summary.permissions && summary.permissions.length > 0 && summary.granted !== false ? (
        <div className="settings-note">
          Permissions: {summary.permissions.join(", ")}
        </div>
      ) : null}

      {summary.options.length > 0 ? (
        <>
          <div className="settings-label">OPTIONS</div>
          <div className="option-list">
            {summary.options.map((option) => {
              if (option.kind === "model") {
                return (
                  <ModelOptionRow
                    key={option.id}
                    label={option.label}
                    value={state.extensionValues[`${summary.id}.${option.id}`] || undefined}
                    models={models}
                    disabled={!summary.active}
                    onChange={(value) => preferences.setValue(summary.id, option.id, value)}
                  />
                );
              }
              if (option.kind === "chips") {
                return (
                  <div className="chip-row" key={option.id}>
                    <span>{option.label}</span>
                    <span className="spacer" />
                    {option.values.map((value) => <span className="chip" key={value}>{value}</span>)}
                  </div>
                );
              }
              if (option.kind === "select") {
                const value = state.extensionValues[`${summary.id}.${option.id}`] || option.defaultValue;
                return (
                  <label className="option-select" key={option.id}>
                    <span>{option.label}</span>
                    <select disabled={!summary.active} value={value} onChange={(event) => preferences.setValue(summary.id, option.id, event.target.value)}>
                      {option.values.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}
                    </select>
                  </label>
                );
              }
              const checked = state.extensionOptions[`${summary.id}.${option.id}`] ?? option.defaultValue;
              return (
                <button
                  className="option-row"
                  key={option.id}
                  role="checkbox"
                  aria-checked={checked}
                  disabled={!summary.active}
                  onClick={() => preferences.setOption(summary.id, option.id, !checked)}
                >
                  <span className={`checkbox ${checked ? "on" : ""}`}>✓</span>
                  <span>{option.label}</span>
                </button>
              );
            })}
          </div>
        </>
      ) : null}

      <PackageProvenance id={summary.id} cwd={cwd} />

      {hostHalf ? (
        <div className="settings-note" data-host-status={hostHalf.error ? "failed" : hostHalf.active ? "active" : "off"}>
          Host entry: {hostHalf.error ? `failed to start (${hostHalf.error})` : hostHalf.active ? `active${hostHalf.commands.length ? `, commands ${hostHalf.commands.join(", ")}` : ""}` : "off"}
          {hostHalf.isolation ? ` · ${hostHalf.isolation === "worker" ? "isolated in a worker" : "in the host process"}` : ""}.
        </div>
      ) : null}
      <div className="settings-note">
        Extensions declare options when they activate; Tau renders this page from that declaration.
        Extensions without options show only the toggle.
      </div>
    </div>
  );
}

/**
 * Development view over every extension the workbench knows: the desktop
 * registry, the host registry and the package folders on disk, with the
 * versions a package's `engines` is checked against.
 */
function InspectorPage({ registry, cwd }: { registry: ExtensionRegistry; cwd?: string }) {
  const client = useHostClient();
  useSyncExternalStore(registry.subscribe, registry.getVersion);
  const [hostHalves, setHostHalves] = useState<HostExtensionSummary[]>([]);
  const [inspection, setInspection] = useState<ExtensionInspection>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let cancelled = false;
    client?.listHostExtensions().then((summaries) => { if (!cancelled) setHostHalves(summaries); }).catch(() => undefined);
    if (cwd) {
      client?.inspectExtensions(cwd)
        .then((result) => { if (!cancelled) setInspection(result); })
        .catch((failure: unknown) => { if (!cancelled) setError(failure instanceof Error ? failure.message : String(failure)); });
    }
    return () => { cancelled = true; };
  }, [client, cwd]);

  const desktop = registry.getExtensionSummaries();
  const unrendered = registry.getUnrenderedContributions();
  const ids = [...new Set([...desktop.map((entry) => entry.id), ...hostHalves.map((entry) => entry.id)])].sort();
  const packages = inspection?.packages ?? [];
  const hostStatus = (half: HostExtensionSummary | undefined) => !half ? "—" : half.error ? `failed: ${half.error}` : half.active ? `active${half.commands.length ? ` · ${half.commands.length} commands` : ""}` : "off";

  return (
    <div className="settings-page inspector-page">
      <h3>Inspector</h3>
      <p className="lede">Every extension both halves know, and the package folders on disk. Edit a package's files, then run /update or /reload.</p>

      <div className="settings-label">VERSIONS</div>
      <div className="inspector-versions">
        <span>Tau <b>{inspection?.versions.tau ?? "…"}</b></span>
        <span>Pi <b>{inspection?.versions.pi ?? "…"}</b></span>
        <span>Extension API <b>{inspection?.versions.api ?? "…"}</b></span>
      </div>

      <div className="settings-label">LOADED</div>
      <table className="inspector-table" aria-label="Loaded extensions">
        <thead><tr><th>Extension</th><th>Desktop</th><th>Host</th><th>Isolation</th><th>Source</th></tr></thead>
        <tbody>
          {ids.map((id) => {
            const desktopHalf = desktop.find((entry) => entry.id === id);
            const hostHalf = hostHalves.find((entry) => entry.id === id);
            const pkg = packages.find((entry) => entry.id === id);
            return (
              <tr key={id} data-extension-id={id}>
                <td><strong>{desktopHalf?.name ?? hostHalf?.name ?? id}</strong><small>{id}{pkg?.version ? ` · ${pkg.version}` : ""}</small></td>
                <td>{desktopHalf ? (desktopHalf.active ? `active${desktopHalf.contributes ? ` · ${desktopHalf.contributes}` : ""}` : "off") : "—"}</td>
                <td data-host-status={hostHalf?.error ? "failed" : hostHalf?.active ? "active" : "off"}>{hostStatus(hostHalf)}</td>
                <td data-isolation={hostHalf?.isolation ?? pkg?.isolation ?? ""}>{hostHalf ? (hostHalf.isolation ?? "in-process") : "—"}</td>
                <td>{pkg ? <span title={pkg.directory}>{pkg.scope} package</span> : "bundled"}</td>
              </tr>
            );
          })}
          {ids.length === 0 ? <tr><td colSpan={5}>No extension is loaded (safe mode).</td></tr> : null}
        </tbody>
      </table>

      <div className="settings-label">NOT ON THIS CLIENT</div>
      <p className="lede">
        This client is the <b>{registry.getProfile()}</b> profile.
        {unrendered.length > 0 ? " These contributions are not drawn here; the extensions and their host halves keep running." : ""}
      </p>
      {unrendered.length > 0 ? (
        <table className="inspector-table" aria-label="Contributions not on this client">
          <thead><tr><th>Extension</th><th>Contribution</th><th>Renders on</th></tr></thead>
          <tbody>
            {unrendered.map((entry) => (
              <tr key={`${entry.extensionId}:${entry.kind}:${entry.id}`} data-extension-id={entry.extensionId}>
                <td><strong>{entry.extensionName}</strong><small>{entry.extensionId}</small></td>
                <td>{entry.kind}<small>{entry.label ?? entry.id}</small></td>
                <td>{entry.profiles.join(", ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <div className="settings-note">It draws every contribution the active extensions offered.</div>}

      <div className="settings-label">PACKAGES ON DISK</div>
      {inspection?.directories.map((entry) => (
        <div className="inspector-folder" key={entry.directory}>
          <span>{entry.scope}</span>
          <code>{entry.directory}</code>
        </div>
      ))}
      {packages.length > 0 ? (
        <table className="inspector-table" aria-label="Extension packages">
          <thead><tr><th>Package</th><th>Entries</th><th>Engines</th><th>Permissions</th><th>Isolation</th><th>Source</th><th>Folder</th></tr></thead>
          <tbody>
            {packages.map((pkg) => (
              <tr key={pkg.directory}>
                <td><strong>{pkg.name}</strong><small>{pkg.id}{pkg.version ? ` · ${pkg.version}` : ""}</small></td>
                <td>{[pkg.desktop ? "desktop" : "", pkg.host ? "host" : ""].filter(Boolean).join(" + ")}</td>
                <td>{pkg.engines ? Object.entries(pkg.engines).map(([engine, range]) => `${engine} ${range}`).join(", ") : "any"}</td>
                <td>{pkg.permissions && pkg.permissions.length > 0 ? pkg.permissions.join(", ") : "none"}</td>
                <td>{pkg.isolation ?? "worker"}</td>
                <td>{pkg.source ? `${pkg.source.url}${pkg.source.commit ? ` (${pkg.source.commit.slice(0, 7)})` : ""}` : "—"}</td>
                <td><code title={pkg.directory}>{pkg.directory.split("/").pop()}</code></td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : inspection ? <div className="settings-note">No package folder carries a tau-extension.json.</div> : null}
      {inspection?.errors.map((failure) => (
        <div className="settings-note" data-level="error" key={failure.path}>{failure.path}: {failure.message}</div>
      ))}
      {inspection?.skipped.map((skip) => (
        <div className="settings-note" key={skip.directory}>{skip.directory}: {skip.reason}</div>
      ))}
      {error ? <div className="settings-note" data-level="error">Could not scan the package folders: {error}</div> : null}
      {!cwd ? <div className="settings-note">Open a project to scan its package folder.</div> : null}
    </div>
  );
}

export function SettingsModal({
  page,
  snapshot,
  registry,
  onSetPage,
  onSetModel,
  onSetThinking,
  onClose,
  onNotify,
}: {
  page: string;
  snapshot?: HostSnapshot;
  registry: ExtensionRegistry;
  onSetPage(page: string): void;
  onSetModel(provider: string, id: string): void;
  onSetThinking(level: string): void;
  onClose(): void;
  onNotify(message: string): void;
}) {
  const preferences = usePreferences();
  useSyncExternalStore(preferences.subscribe, preferences.getSnapshot);
  useSyncExternalStore(registry.subscribe, registry.getVersion);
  const loaded = registry.getExtensionSummaries();
  const [answered, setAnswered] = useState(0);
  const awaiting = useAwaitingApproval(snapshot?.cwd, loaded, answered);
  const summaries = [...loaded, ...awaiting];
  const active = summaries.find((summary) => summary.id === page);
  // Pages extensions own. Core keeps Defaults, Keybindings and the Inspector,
  // so safe mode still has a model picker and a way to see what is loaded.
  const pages = registry.getSettingsPages();
  const contributed = pages.find((entry) => entry.id === page);
  const installer = pages.find((entry) => entry.id === "packages");

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="modal-scrim" onMouseDown={onClose}>
      <section
        className="settings-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <strong>Settings</strong>
          <small>tau · desktop</small>
          <span className="spacer" />
          <button className="chrome-ghost glyph" aria-label="Close settings" onClick={onClose}><X size={15} /></button>
        </header>
        <div className="settings-body">
          <nav className="settings-nav">
            <button className={page === "defaults" ? "active" : ""} onClick={() => onSetPage("defaults")}>
              <Sliders size={14} /><span>Defaults</span>
            </button>
            <button className={page === "keybindings" ? "active" : ""} onClick={() => onSetPage("keybindings")}>
              <Command size={14} /><span>Keybindings</span>
            </button>
            {pages.map((entry) => (
              <button key={entry.id} className={page === entry.id ? "active" : ""} onClick={() => onSetPage(entry.id)}>
                <PanelIcon Icon={entry.Icon} size={14} /><span>{entry.label}</span>
              </button>
            ))}
            <button className={page === "inspector" ? "active" : ""} onClick={() => onSetPage("inspector")}>
              <Puzzle size={14} /><span>Inspector</span>
            </button>
            <div className="settings-nav-heading">EXTENSIONS</div>
            {summaries.filter((summary) => !summary.core).map((summary) => (
              <button
                key={summary.id}
                className={`${page === summary.id ? "active" : ""} ${summary.active ? "" : "off"}`}
                onClick={() => onSetPage(summary.id)}
              >
                <span className={`extension-dot ${summary.active ? "" : "off"}`} />
                <span>{summary.name}</span>
                {summary.active ? null : <small>OFF</small>}
              </button>
            ))}
            <div className="settings-nav-heading">CORE</div>
            {summaries.filter((summary) => summary.core).map((summary) => (
              <button
                key={summary.id}
                className={page === summary.id ? "active" : ""}
                onClick={() => onSetPage(summary.id)}
              >
                <span className="extension-dot" />
                <span>{summary.name}</span>
              </button>
            ))}
            <span className="spacer" />
            {installer ? (
              <button
                className="install-extension"
                onClick={() => onSetPage(installer.id)}
              >
                <Plus size={13} /> Install extension…
              </button>
            ) : null}
          </nav>

          {page === "defaults" ? (
            <DefaultsPage
              snapshot={snapshot}
              onSetModel={onSetModel}
              onSetThinking={onSetThinking}
            />
          ) : page === "keybindings" ? (
            <div className="settings-page">
              <h3>Keybindings</h3>
              <p className="lede">Chords extensions bound to their commands; the first binding of a chord wins.</p>
              <div className="keybinding-list">
                {registry.getKeybindings().map((binding) => (
                  <div className="keybinding-row" key={binding.keys}>
                    <span>{registry.getCommands().find((command) => command.id === binding.commandId)?.label ?? binding.commandId}</span>
                    <small>{binding.extensionName.toLowerCase()}</small>
                    <kbd>{binding.label}</kbd>
                  </div>
                ))}
                {registry.getKeybindings().length === 0 ? <div className="keybinding-row"><span>No extension binds a key.</span></div> : null}
              </div>
              {registry.getKeybindingConflicts().map((conflict) => (
                <div className="settings-note" key={`${conflict.keys}:${conflict.commandId}`}>
                  {conflict.keys} from {conflict.extensionId} ({conflict.commandId}) was ignored: {conflict.boundTo.extensionId} bound it to {conflict.boundTo.commandId} first.
                </div>
              ))}
              <div className="settings-note">Pi's <code>~/.pi/agent/keybindings.json</code> rebinds the runtime commands (app.session.new, app.interrupt, app.model.select, app.thinking.toggle) and the shortcuts Pi extensions register; run /reload after editing it.</div>
            </div>
          ) : contributed ? (
            <contributed.Component cwd={snapshot?.cwd} onNotify={onNotify} />
          ) : page === "inspector" ? (
            <InspectorPage registry={registry} cwd={snapshot?.cwd} />
          ) : active ? (
            <ExtensionPage summary={active} registry={registry} models={snapshot?.models ?? []} cwd={snapshot?.cwd} onChanged={() => { setAnswered((count) => count + 1); onSetPage(active.id); }} onNotify={onNotify} />
          ) : (
            <div className="settings-page"><p className="lede">Select a page.</p></div>
          )}
        </div>
      </section>
    </div>
  );
}
