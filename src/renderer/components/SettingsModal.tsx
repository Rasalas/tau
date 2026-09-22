import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { ChevronDown, Command, Cpu, Plus, Puzzle, Sliders, Sparkles, X } from "lucide-react";
import type { ExtensionInspection, HostExtensionSummary, HostSnapshot, UiModel } from "../../shared/contracts";
import type { ExtensionRegistry, ExtensionSummary } from "../extension-system";
import { NETWORK_ADVISORY_NOTE } from "../../shared/extension-permissions";
import { TRANSCRIPT_DETAIL_LEVELS } from "../../workbench/transcript-folding";
import { allAvailableThemes, getUserTheme } from "../theme";
import { usePreferences } from "../renderer-services-context";
import { effectiveNewThreadRuntime } from "../new-thread-runtime";
import { useHostClient } from "../host-client-context";
import { ModelPicker, modelKey } from "./ModelPicker";
import { AddModelProviderModal } from "./AddModelProviderModal";
import { SystemPromptModal } from "./SystemPromptModal";
import { PackageProvenance } from "./PackageProvenance";
import { PanelIcon } from "./PanelIcon";
import { ProviderIconStack } from "./ProviderIconStack";
import { PiSettingsPage } from "./PiSettingsPage";
import type { SendShortcut } from "./composer-send-keys";

const SEND_SHORTCUT_LABELS: ReadonlyArray<readonly [SendShortcut, string]> = [
  ["enter", "↵"],
  ["mod-enter-multiline", "⌘↵ for several lines"],
  ["mod-enter", "⌘↵"],
];

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
  const [addProviderOpen, setAddProviderOpen] = useState(false);
  const preferences = usePreferences();
  const { showCosts, continueThreadsAfterRestart, transcriptDetail, theme, newThreadRuntime: runtimePreference, fontSize, fontFamily, vimMode, sendShortcut, temperature, maxTokens, hostBackground } = useSyncExternalStore(preferences.subscribe, preferences.getSnapshot);
  const newThreadRuntime = effectiveNewThreadRuntime(runtimePreference, snapshot);

  return (
    <div className="settings-page">
      <h3>Defaults</h3>
      <p className="lede">Seed for new threads — override any of these per thread in the composer.</p>

      <div className="settings-label">MODEL</div>
      <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
        <button className="settings-field" style={{ flex: 1 }} onClick={() => setPickerOpen(true)}>
          {snapshot?.model
            ? <ProviderIconStack modelProvider={snapshot.model.provider} runtimeProvider={snapshot.backendKind} className="chip-icon" />
            : <Sparkles size={14} className="accent" />}
          <span>
            <strong>{snapshot?.model?.name ?? "No model selected"}</strong>
            <small>{snapshot?.model?.provider ?? "pi"} · via ~/.pi/agent{snapshot?.model?.login === "subscription" ? " · subscription login" : ""}</small>
          </span>
          <b><ChevronDown size={13} /></b>
        </button>
        <button
          className="settings-field"
          style={{ width: "auto", padding: "0 12px", justifyContent: "center" }}
          onClick={() => setAddProviderOpen(true)}
          title="Add custom model provider"
          aria-label="Add custom model provider"
        >
          <Plus size={14} />
        </button>
      </div>
      {pickerOpen ? (
        <ModelPicker
          models={snapshot?.models ?? []}
          activeKey={snapshot?.model ? modelKey(snapshot.model) : undefined}
          onSelect={(model) => onSetModel(model.provider, model.id)}
          onClose={() => setPickerOpen(false)}
          runtime={snapshot?.backendKind}
        />
      ) : null}
      {addProviderOpen ? (
        <AddModelProviderModal
          onClose={() => setAddProviderOpen(false)}
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
        {allAvailableThemes().map((preference) => (
          <button
            key={preference}
            className={preference === theme ? "active" : ""}
            onClick={() => preferences.setTheme(preference)}
          >
            {getUserTheme(preference)?.name ?? preference}
          </button>
        ))}
      </div>
      <p className="settings-note">
        System follows this machine's light or dark setting. Custom themes can be added as <code>.css</code> or <code>.json</code> files in <code>~/.tau/themes/</code>.
      </p>

      <div className="settings-label">FONT SIZE</div>
      <div className="segmented">
        {[11, 12, 13, 14, 15].map((size) => (
          <button
            key={size}
            className={(fontSize ?? 13) === size ? "active" : ""}
            onClick={() => preferences.setFontSize(size === 13 ? undefined : size)}
          >
            {size === 13 ? "13px (default)" : `${size}px`}
          </button>
        ))}
      </div>

      <div className="settings-label">FONT FAMILY</div>
      <div style={{ display: "flex", gap: "8px", alignItems: "center", maxWidth: "420px" }}>
        <input
          type="text"
          className="settings-search-input"
          style={{ flex: 1 }}
          placeholder="System sans (default) — e.g. 'JetBrains Mono', monospace"
          value={fontFamily ?? ""}
          onChange={(e) => preferences.setFontFamily(e.target.value.trim() ? e.target.value : undefined)}
        />
        {fontFamily ? (
          <button
            className="text-button"
            style={{ whiteSpace: "nowrap" }}
            onClick={() => preferences.setFontFamily(undefined)}
            title="Reset to default font"
          >
            Reset
          </button>
        ) : null}
      </div>
      <p className="settings-note">Override the interface font family.</p>

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

      <div className="settings-label">HOST</div>
      <div className="settings-toggle-row">
        <span>
          <strong>Keep the host running in the background</strong>
          <small>Threads keep working after you quit Tau, and the next start picks them up again.</small>
        </span>
        <button
          className={`switch ${hostBackground ? "on" : ""}`}
          role="switch"
          aria-checked={hostBackground === true}
          aria-label="Keep the host running in the background"
          onClick={() => preferences.setHostBackground(!hostBackground)}
        >
          <i />
        </button>
      </div>

      <div className="settings-label">RESTARTS</div>
      <div className="settings-toggle-row">
        <span>
          <strong>Continue threads after restarts</strong>
          <small>Pick a thread back up where a restart cut its turn short. Off, the thread is repaired and marked instead.</small>
        </span>
        <button
          className={`switch ${continueThreadsAfterRestart ? "on" : ""}`}
          role="switch"
          aria-checked={continueThreadsAfterRestart}
          aria-label="Continue threads after restarts"
          onClick={() => preferences.setContinueThreadsAfterRestart(!continueThreadsAfterRestart)}
        >
          <i />
        </button>
      </div>

      <div className="settings-label">COMPOSER EDITING MODE</div>
      <div className="segmented">
        <button
          className={!vimMode ? "active" : ""}
          onClick={() => preferences.setVimMode(false)}
        >
          Standard (Readline)
        </button>
        <button
          className={vimMode ? "active" : ""}
          onClick={() => preferences.setVimMode(true)}
        >
          Vim (Modal)
        </button>
      </div>
      <p className="settings-note">
        Standard provides Readline / Emacs shortcuts. Vim mode enables modal editing in the composer with Normal and Insert modes.
      </p>

      <div className="settings-label">SEND WITH</div>
      <div className="segmented" role="group" aria-label="Send with">
        {SEND_SHORTCUT_LABELS.map(([value, label]) => (
          <button key={value} className={value === sendShortcut ? "active" : ""} aria-pressed={value === sendShortcut} onClick={() => preferences.setSendShortcut(value)}>
            {label}
          </button>
        ))}
      </div>
      <p className="settings-note">
        While a turn runs the send chord queues a follow-up and ⌘↵ steers the turn (⌘⇧↵ when ⌘↵ sends); an extension may swap the two.
      </p>

      <div className="settings-label">MODEL PARAMETERS</div>
      <div style={{ display: "flex", gap: "16px", flexWrap: "wrap", alignItems: "center" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
          <label style={{ fontSize: "11px", color: "var(--ink-muted)", fontWeight: 500 }}>Temperature</label>
          <input
            type="number"
            step="0.1"
            min="0"
            max="2"
            className="settings-search-input"
            style={{ width: "120px" }}
            placeholder="Default"
            value={temperature !== undefined ? String(temperature) : ""}
            onChange={(e) => {
              const val = e.target.value.trim();
              preferences.setTemperature(val ? parseFloat(val) : undefined);
            }}
          />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
          <label style={{ fontSize: "11px", color: "var(--ink-muted)", fontWeight: 500 }}>Max Tokens</label>
          <input
            type="number"
            step="256"
            min="1"
            className="settings-search-input"
            style={{ width: "120px" }}
            placeholder="Default"
            value={maxTokens !== undefined ? String(maxTokens) : ""}
            onChange={(e) => {
              const val = e.target.value.trim();
              preferences.setMaxTokens(val ? parseInt(val, 10) : undefined);
            }}
          />
        </div>
      </div>
      <p className="settings-note">Optional sampling parameters for model generations.</p>

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
              <p className="settings-note">{NETWORK_ADVISORY_NOTE}, so this package can reach the network and start processes whatever it asked for.</p>
            </>
          ) : (
            <p className="settings-note">In its worker, network and process access are refused without the matching grant — a guardrail against a mistake, not against code written to get around it.</p>
          )}
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
  const problems = registry.getProblems();
  const ids =[...new Set([...desktop.map((entry) => entry.id), ...hostHalves.map((entry) => entry.id)])].sort();
  const packages = inspection?.packages ?? [];
  const hostStatus = (half: HostExtensionSummary | undefined) => !half ? "—" : half.error ? `failed: ${half.error}` : half.active ? `active${half.commands.length ? ` · ${half.commands.length} commands` : ""}` : "off";
  const [systemPromptOpen, setSystemPromptOpen] = useState(false);

  return (
    <div className="settings-page inspector-page">
      <h3>Inspector</h3>
      <p className="lede">Every extension both halves know, and the package folders on disk. Editing a package's files reloads it; /reload is for the rest.</p>

      <div className="settings-label">VERSIONS</div>
      <div className="inspector-versions">
        <span>Tau <b>{inspection?.versions.tau ?? "…"}</b></span>
        <span>Pi <b>{inspection?.versions.pi ?? "…"}</b></span>
        <span>Extension API <b>{inspection?.versions.api ?? "…"}</b></span>
      </div>

      <div className="settings-label">ACTIVE INSTRUCTIONS & SYSTEM PROMPT</div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 12px", background: "var(--sunken)", borderRadius: "8px", marginBottom: "16px" }}>
        <div>
          <strong style={{ fontSize: "12.5px" }}>Live System Prompt & Persona</strong>
          <p style={{ margin: "2px 0 0", fontSize: "11px", color: "var(--muted)" }}>
            Inspect active instructions, appended rules, and loaded AGENTS.md context.
          </p>
        </div>
        <button
          className="chrome-button"
          onClick={() => setSystemPromptOpen(true)}
          style={{ fontSize: "12px", padding: "5px 10px" }}
        >
          View System Prompt…
        </button>
      </div>
      {systemPromptOpen ? (
        <SystemPromptModal onClose={() => setSystemPromptOpen(false)} />
      ) : null}

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

      {problems.length > 0 ? (
        <>
          <div className="settings-label">PROBLEMS</div>
          {problems.map((problem, index) => (
            <div className="settings-note" data-level={problem.level ?? "error"} data-extension-id={problem.extensionId} key={`${problem.extensionId}:${index}`}>
              <strong>{problem.extensionName}</strong> · <code>{problem.source}</code>: {problem.message}
            </div>
          ))}
        </>
      ) : null}

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
      {registry.getLoadFailures().map((failure) => (
        <div className="settings-note" data-level="error" key={`load:${failure.path}`}>
          {failure.path}: {failure.message.split("\n")[0]} — the version that was running stays until this builds.
        </div>
      ))}
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

function KeybindingsPage({ registry }: { registry: ExtensionRegistry }) {
  const [filter, setFilter] = useState("");
  const [showAllCommands, setShowAllCommands] = useState(false);

  const keybindings = registry.getKeybindings();
  const commands = registry.getCommands();
  const conflicts = registry.getKeybindingConflicts();

  const query = filter.trim().toLowerCase();
  // A keybindings.json names a Pi action by its own id. When Tau implements no
  // command for it the chord is registered but nothing runs, so it belongs in
  // its own list rather than under "active".
  const implemented = keybindings.filter((binding) => commands.some((command) => command.id === binding.commandId));
  const unimplemented = keybindings.filter((binding) => !commands.some((command) => command.id === binding.commandId));

  const filteredBindings = useMemo(() => {
    if (!query) return implemented;
    return implemented.filter((b) => {
      const cmd = commands.find((c) => c.id === b.commandId);
      const label = cmd?.label?.toLowerCase() ?? "";
      return (
        label.includes(query) ||
        b.commandId.toLowerCase().includes(query) ||
        b.keys.toLowerCase().includes(query) ||
        b.label.toLowerCase().includes(query) ||
        b.extensionName.toLowerCase().includes(query)
      );
    });
  }, [implemented, commands, query]);

  const filteredUnimplemented = useMemo(() => {
    if (!query) return unimplemented;
    return unimplemented.filter((b) =>
      b.commandId.toLowerCase().includes(query) ||
      b.keys.toLowerCase().includes(query) ||
      b.extensionName.toLowerCase().includes(query)
    );
  }, [unimplemented, query]);

  const filteredCommands = useMemo(() => {
    if (!query) return commands;
    return commands.filter((c) =>
      c.label.toLowerCase().includes(query) ||
      c.id.toLowerCase().includes(query) ||
      c.group.toLowerCase().includes(query)
    );
  }, [commands, query]);

  return (
    <div className="settings-page">
      <h3>Keybindings</h3>
      <p className="lede">Chords bound to workbench commands and Pi actions; configure custom chords in <code>~/.pi/agent/keybindings.json</code>.</p>

      <div style={{ margin: "14px 0 10px 0" }}>
        <input
          type="search"
          className="settings-search-input"
          placeholder="Filter keybindings or commands…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>

      <div className="settings-label" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", maxWidth: "460px" }}>
        <span>ACTIVE KEYBINDINGS ({filteredBindings.length})</span>
        <button
          className="text-button"
          onClick={() => setShowAllCommands((v) => !v)}
        >
          {showAllCommands ? "Hide all command IDs" : "Show all command IDs"}
        </button>
      </div>

      <div className="keybinding-list">
        {filteredBindings.map((binding) => (
          <div className="keybinding-row" key={binding.keys}>
            <span>
              <strong>{commands.find((command) => command.id === binding.commandId)?.label ?? binding.commandId}</strong>
              <small style={{ display: "block", opacity: 0.7, fontSize: "10.5px" }}>{binding.commandId} · {binding.extensionName.toLowerCase()}</small>
            </span>
            <kbd>{binding.label}</kbd>
          </div>
        ))}
        {filteredBindings.length === 0 ? (
          <div className="keybinding-row"><span>No keybindings match &ldquo;{filter}&rdquo;.</span></div>
        ) : null}
      </div>

      {filteredUnimplemented.length > 0 ? (
        <>
          <div className="settings-label" style={{ marginTop: "24px", maxWidth: "460px" }}>
            NOT IMPLEMENTED BY TAU ({filteredUnimplemented.length})
          </div>
          <p className="settings-note">
            <code>~/.pi/agent/keybindings.json</code> names these Pi actions, but Tau has no command for them, so
            pressing the chord does nothing. The equivalent Pi terminal action has no workbench counterpart.
          </p>
          <div className="keybinding-list">
            {filteredUnimplemented.map((binding) => (
              <div className="keybinding-row" key={binding.keys} data-level="unimplemented">
                <span>
                  <strong>{binding.commandId}</strong>
                  <small style={{ display: "block", opacity: 0.7, fontSize: "10.5px" }}>{binding.extensionName.toLowerCase()}</small>
                </span>
                <kbd>{binding.label}</kbd>
              </div>
            ))}
          </div>
        </>
      ) : null}

      {conflicts.map((conflict) => (
        <div className="settings-note" key={`${conflict.keys}:${conflict.commandId}`}>
          {conflict.keys} from {conflict.extensionId} ({conflict.commandId}) was ignored: {conflict.boundTo.extensionId} bound it to {conflict.boundTo.commandId} first.
        </div>
      ))}

      {showAllCommands ? (
        <>
          <div className="settings-label" style={{ marginTop: "24px", maxWidth: "460px" }}>
            ALL REGISTERED COMMANDS ({filteredCommands.length})
          </div>
          <p className="settings-note">Use any of these command IDs in <code>~/.pi/agent/keybindings.json</code> to bind custom chords.</p>
          <div className="keybinding-list">
            {filteredCommands.map((command) => {
              const bound = keybindings.filter((b) => b.commandId === command.id);
              return (
                <div className="keybinding-row" key={command.id}>
                  <span>
                    <strong>{command.label}</strong>
                    <small style={{ display: "block", opacity: 0.7, fontSize: "10.5px" }}><code>{command.id}</code> ({command.group})</small>
                  </span>
                  <div>
                    {bound.length > 0 ? (
                      bound.map((b) => <kbd key={b.keys} style={{ marginLeft: "4px" }}>{b.label}</kbd>)
                    ) : (
                      <span style={{ fontSize: "11px", opacity: 0.5 }}>Unbound</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      ) : null}

      <div className="settings-note" style={{ marginTop: "18px" }}>
        Pi&apos;s <code>~/.pi/agent/keybindings.json</code> rebinds any command ID (e.g. <code>runtime.abort</code>, <code>workspace.open-prompt-editor</code>, <code>workbench.toggle-dock</code>) or Pi action (<code>app.session.new</code>, <code>app.interrupt</code>, <code>app.model.select</code>, <code>app.thinking.toggle</code>, <code>app.session.tree</code>, <code>app.session.fork</code>, <code>app.editor.open</code>); run <code>/reload</code> after editing it.
      </div>
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
            <button className={page === "pi" ? "active" : ""} onClick={() => onSetPage("pi")}>
              <Cpu size={14} /><span>Pi</span>
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
            <KeybindingsPage registry={registry} />
          ) : page === "pi" ? (
            <PiSettingsPage snapshot={snapshot} onNotify={onNotify} />
          ) : contributed ? (
            <contributed.Component cwd={snapshot?.cwd} onNotify={onNotify} />
          ) : page === "inspector" ? (
            <InspectorPage registry={registry} cwd={snapshot?.cwd} />
          ) : active ? (
            <ExtensionPage summary={active} registry={registry} models={snapshot?.completionModels ?? snapshot?.models ?? []} cwd={snapshot?.cwd} onChanged={() => { setAnswered((count) => count + 1); onSetPage(active.id); }} onNotify={onNotify} />
          ) : (
            <div className="settings-page"><p className="lede">Select a page.</p></div>
          )}
        </div>
      </section>
    </div>
  );
}
