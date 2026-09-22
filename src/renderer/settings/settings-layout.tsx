import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { Check, Layers, Undo2 } from "lucide-react";
import { resolveSetting, settingWritable, type ConfigLayerName, type SettingLayerValue, type SettingScope } from "../../shared/config-layers";
import { ConfigLayersStore, type ConfigLayersSnapshot, type SettingsProject } from "../../workbench/config-layers-store";
import { useHostClient } from "../host-client-context";
import { usePreferences } from "../renderer-services-context";

const SettingsLevelsContext = createContext<ConfigLayersStore | undefined>(undefined);

/** The levels every row inside reads and writes; the Settings screen provides one. */
export function SettingsLevelsProvider({ store, children }: { store: ConfigLayersStore; children: ReactNode }) {
  return <SettingsLevelsContext.Provider value={store}>{children}</SettingsLevelsContext.Provider>;
}

/** The store of the Settings screen, or one of its own for a row drawn anywhere else. */
export function useSettingsLevels(): { store: ConfigLayersStore; snapshot: ConfigLayersSnapshot } {
  const provided = useContext(SettingsLevelsContext);
  const client = useHostClient();
  const preferences = usePreferences();
  const [own] = useState(() => provided ? undefined : new ConfigLayersStore(client, () => void preferences.syncFromHost()));
  useEffect(() => { if (own) void own.refresh(); }, [own]);
  const store = provided ?? own!;
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return { store, snapshot };
}

export interface SettingOptions<T> {
  /** What applies when no level sets the key. */
  defaultValue: T;
  /** The levels the setting may be written to; "host" unless it means something per project. */
  scope?: SettingScope;
  /** Turns what a level holds into a value; undefined skips that level. */
  read?(raw: unknown): T | undefined;
  /** What is written for a value; the value itself by default. */
  write?(value: T): unknown;
  /** How a value reads in the origin popover. */
  format?(value: T): string;
  /** Where a change goes when there is no host to write a level to: the client's own preferences. */
  offline?(value: T): void;
}

export interface SettingHandle<T> {
  key: string;
  scope: SettingScope;
  value: T;
  origin: ConfigLayerName;
  chain: readonly SettingLayerValue[];
  /** While the host level is edited: what the project holds, which hides the host's value there. */
  projectOverride?: T;
  editing: "host" | "project";
  project?: SettingsProject;
  writable: boolean;
  loaded: boolean;
  set(value: T): void;
  /** Removes the value from the level being edited. */
  reset(): void;
  /** Edits the project level, for an override. */
  editProject(): void;
  editHost(): void;
  format(value: unknown): string;
}

function defaultFormat(value: unknown): string {
  if (value === undefined || value === null) return "Not set";
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (value === "") return "Empty";
  return String(value);
}

/**
 * One key of Tau's config read across the levels (default, host, project):
 * its value for the level being edited, where that value comes from, and a
 * setter that writes to that level. `key` is a config path: `showCosts`, or an
 * entry of a record such as `values.<extension>.<name>`.
 */
export function useSetting<T>(key: string, options: SettingOptions<T>): SettingHandle<T> {
  const { store, snapshot } = useSettingsLevels();
  const scope = options.scope ?? "host";
  const resolved = resolveSetting(snapshot.layers, key, options.defaultValue, snapshot.editing, options.read);
  const format = (value: unknown) => {
    if (value === undefined) return "Not set";
    return options.format ? options.format(value as T) : defaultFormat(value);
  };
  return {
    key,
    scope,
    value: resolved.value,
    origin: resolved.origin,
    chain: resolved.chain,
    ...(resolved.projectOverride !== undefined ? { projectOverride: resolved.projectOverride } : {}),
    editing: snapshot.editing,
    ...(snapshot.project ? { project: snapshot.project } : {}),
    writable: settingWritable(scope, snapshot.editing),
    loaded: snapshot.loaded,
    set: (value) => {
      if (store.available) void store.write(key, options.write ? options.write(value) : value);
      else options.offline?.(value);
    },
    reset: () => void store.clear(key),
    editProject: () => store.edit("project"),
    editHost: () => store.edit("host"),
    format,
  };
}

const LEVEL_LABELS: Record<ConfigLayerName, string> = { project: "Project", host: "This machine", default: "Default" };

function originSummary(setting: SettingHandle<unknown>): string {
  if (setting.origin === "project") return `Overridden for ${setting.project?.label ?? "this project"}`;
  if (setting.editing === "project" && setting.origin === "host") return "Inherited from this machine";
  if (setting.origin === "host") {
    return setting.projectOverride !== undefined
      ? `Set on this machine · overridden in ${setting.project?.label ?? "a project"}`
      : "Set on this machine";
  }
  return setting.projectOverride !== undefined ? `Built-in default · overridden in ${setting.project?.label ?? "a project"}` : "Built-in default";
}

/**
 * The layers glyph beside a row's title. It opens where the value comes from,
 * top-down, and the one move that level allows: override it for the project,
 * or reset the override.
 */
export function SettingOrigin({ setting }: { setting: SettingHandle<unknown> }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setOpen(false);
    };
    window.addEventListener("keydown", close, true);
    return () => window.removeEventListener("keydown", close, true);
  }, [open]);
  const summary = originSummary(setting);
  const canOverride = setting.editing === "host" && setting.scope !== "host" && setting.project;
  return (
    <span className="setting-origin">
      <button
        type="button"
        className="setting-origin-trigger"
        data-origin={setting.origin}
        data-overridden={setting.projectOverride !== undefined ? "" : undefined}
        aria-label={`${summary}. Show where this value comes from`}
        aria-expanded={open}
        title={summary}
        onClick={() => setOpen(!open)}
      ><Layers size={12} /></button>
      {open ? <>
        <button type="button" className="menu-scrim" aria-label="Close" onClick={() => setOpen(false)} />
        <div className="setting-origin-popover" role="dialog" aria-label="Where this value comes from">
          <h4>{setting.editing === "project" ? setting.project?.label ?? "Project" : "This machine"}</h4>
          <ol>
            {setting.chain.map((layer) => (
              <li key={layer.layer} data-effective={layer.effective ? "" : undefined}>
                <span>{LEVEL_LABELS[layer.layer]}</span>
                <b>{layer.set ? setting.format(layer.value) : "Inherits"}</b>
                {layer.effective ? <Check size={12} aria-label="applies" /> : <i aria-hidden />}
              </li>
            ))}
          </ol>
          {setting.editing === "host" && setting.projectOverride !== undefined ? (
            <div className="setting-origin-override">
              <span>Overridden in {setting.project?.label ?? "the project"}: <b>{setting.format(setting.projectOverride)}</b></span>
              <button type="button" className="text-button" onClick={() => { setOpen(false); setting.editProject(); }}>Edit override</button>
            </div>
          ) : canOverride ? (
            <button type="button" className="text-button setting-origin-action" onClick={() => { setOpen(false); setting.editProject(); }}>
              Override for {setting.project!.label}
            </button>
          ) : null}
          {setting.editing === "project" && setting.origin === "project" ? (
            <button type="button" className="text-button setting-origin-action" onClick={() => { setOpen(false); setting.reset(); }}>
              Reset to inherited value
            </button>
          ) : null}
        </div>
      </> : null}
    </span>
  );
}

/** A muted heading over one card of rows, the way a Settings page groups what belongs together. */
export function SettingsSection({ title, id, headerAction, children, plain = false }: {
  title: string;
  id?: string;
  headerAction?: ReactNode;
  /** Rows without the card around them, for content that draws its own. */
  plain?: boolean;
  children: ReactNode;
}) {
  return (
    <section className="settings-section" id={id}>
      <div className="settings-section-head">
        <h2>{title}</h2>
        {headerAction ? <div className="settings-section-action">{headerAction}</div> : null}
      </div>
      <div className={plain ? "settings-group plain" : "settings-group"}>{children}</div>
    </section>
  );
}

function notWritableReason(setting: SettingHandle<unknown>): string {
  return setting.editing === "project"
    ? "A setting of this machine. Switch the scope to This machine to change it."
    : "A setting of each project. Choose a project in the scope menu to change it.";
}

/**
 * One setting: what it is on the left, its control on the right. With a
 * `setting` handle the row shows where the value comes from, resets what the
 * level being edited holds, and turns its control inert where that level
 * cannot hold the key.
 */
export function SettingRow({ id, title, description, status, control, setting, children }: {
  /** The row's anchor: a search result scrolls here. */
  id?: string;
  title: ReactNode;
  description?: ReactNode;
  status?: ReactNode;
  control?: ReactNode;
  setting?: SettingHandle<never> | SettingHandle<unknown>;
  children?: ReactNode;
}) {
  const handle = setting as SettingHandle<unknown> | undefined;
  const inert = handle !== undefined && !handle.writable;
  const resettable = handle !== undefined && handle.writable && handle.origin === handle.editing;
  return (
    <div className="settings-row" id={id} tabIndex={id ? -1 : undefined} data-origin={handle?.origin}>
      <div className="settings-row-main">
        <div className="settings-row-text">
          <div className="settings-row-title">
            <h3>{title}</h3>
            {handle ? <SettingOrigin setting={handle} /> : null}
            {resettable ? (
              <button
                type="button"
                className="setting-reset"
                aria-label={`Reset ${typeof title === "string" ? title : "setting"} to ${handle.editing === "project" ? "inherited value" : "default"}`}
                title={handle.editing === "project" ? "Reset to inherited value" : "Reset to default"}
                onClick={() => handle.reset()}
              ><Undo2 size={12} /></button>
            ) : null}
          </div>
          {description ? <p>{description}</p> : null}
          {status ? <div className="settings-row-status">{status}</div> : null}
        </div>
        {control ? (
          // The reason sits on a wrapper: an inert element shows no tooltip of its own.
          <div className="settings-row-control" data-inert={inert ? "" : undefined} title={inert ? notWritableReason(handle!) : undefined}>
            {inert ? <div className="settings-row-control-inert" inert>{control}</div> : control}
          </div>
        ) : null}
      </div>
      {children}
    </div>
  );
}
