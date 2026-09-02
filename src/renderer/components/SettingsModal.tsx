import { useEffect, useState, useSyncExternalStore } from "react";
import { ChevronDown, Command, Plus, Sliders, Sparkles, X } from "lucide-react";
import type { HostSnapshot } from "../../shared/contracts";
import type { ExtensionRegistry, ExtensionSummary } from "../extension-system";
import { preferences } from "../preferences";
import { ModelPicker, modelKey } from "./ModelPicker";

const KEYBINDINGS: ReadonlyArray<{ label: string; keys: string; source: string }> = [
  { label: "Command palette", keys: "⌘K", source: "core" },
  { label: "New thread", keys: "⌘N", source: "runtime controls" },
  { label: "Open project…", keys: "⌘P", source: "workspace kit" },
  { label: "Search threads", keys: "/", source: "workspace kit" },
  { label: "Settle thread", keys: "⌘⇧S", source: "workspace kit" },
  { label: "Signals panel", keys: "⌘⇧O", source: "signals" },
  { label: "Stop the run", keys: "Esc", source: "runtime controls" },
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

    </div>
  );
}

function ExtensionPage({
  summary,
  registry,
  onChanged,
}: {
  summary: ExtensionSummary;
  registry: ExtensionRegistry;
  onChanged(): void;
}) {
  const state = useSyncExternalStore(preferences.subscribe, preferences.getSnapshot);

  const toggleExtension = () => {
    const next = !summary.active;
    preferences.setExtensionEnabled(summary.id, next);
    registry.setActive(summary.id, next);
    onChanged();
  };

  return (
    <div className="settings-page">
      <div className="extension-head">
        <span>
          <strong>{summary.name}</strong>
          <small>{summary.contributes ? `contributes ${summary.contributes}` : "no contributions"}</small>
        </span>
        <button
          className={`switch ${summary.active ? "on" : ""}`}
          role="switch"
          aria-checked={summary.active}
          aria-label={`${summary.active ? "Disable" : "Enable"} ${summary.name}`}
          onClick={toggleExtension}
        >
          <i />
        </button>
      </div>

      {summary.options.length > 0 ? (
        <>
          <div className="settings-label">OPTIONS</div>
          <div className="option-list">
            {summary.options.map((option) => {
              if (option.kind === "chips") {
                return (
                  <div className="chip-row" key={option.id}>
                    <span>{option.label}</span>
                    <span className="spacer" />
                    {option.values.map((value) => <span className="chip" key={value}>{value}</span>)}
                  </div>
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

      <div className="settings-note">
        Extensions declare options when they activate; Tau renders this page from that declaration.
        Extensions without options show only the toggle.
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
  const state = useSyncExternalStore(preferences.subscribe, preferences.getSnapshot);
  useSyncExternalStore(registry.subscribe, registry.getVersion);
  const summaries = registry.getExtensionSummaries();
  const active = summaries.find((summary) => summary.id === page);

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
            <div className="settings-nav-heading">EXTENSIONS</div>
            {summaries.map((summary) => (
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
            <span className="spacer" />
            <button
              className="install-extension"
              onClick={() => onNotify("Installing extensions from disk is not wired up in this prototype.")}
            >
              <Plus size={13} /> Install extension…
            </button>
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
              <p className="lede">Shortcuts the workbench and its extensions currently claim.</p>
              <div className="keybinding-list">
                {KEYBINDINGS.map((binding) => (
                  <div className="keybinding-row" key={binding.label}>
                    <span>{binding.label}</span>
                    <small>{binding.source}</small>
                    <kbd>{binding.keys}</kbd>
                  </div>
                ))}
              </div>
              <div className="settings-note">Rebinding is not implemented in this prototype.</div>
            </div>
          ) : active ? (
            <ExtensionPage summary={active} registry={registry} onChanged={() => onSetPage(active.id)} />
          ) : (
            <div className="settings-page"><p className="lede">Select a page.</p></div>
          )}
        </div>
      </section>
    </div>
  );
}
