import { useEffect, useState, type ReactNode } from "react";
import { Check, Layers, Undo2 } from "lucide-react";
import type { ConfigLayerName } from "../../shared/config-layers";
import type { SettingHandle } from "./setting-state";

// The hooks live apart so the `tau` module reaches `useSetting` without loading these rows.
export { SettingsLevelsProvider, useSetting, useSettingsLevels, type SettingHandle, type SettingOptions } from "./setting-state";

const LEVEL_LABELS: Record<ConfigLayerName, string> = { project: "Project", host: "This machine", default: "Default" };

function originSummary({ origin, editing, project, projectOverride }: SettingHandle<unknown>): string {
  const label = project?.label ?? "the project";
  if (origin === "project") return `Overridden for ${label}`;
  const base = origin === "default" ? "Built-in default" : editing === "project" ? "Inherited from this machine" : "Set on this machine";
  return projectOverride === undefined ? base : `${base} · overridden in ${label}`;
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

/** The on/off control of a row. */
export function Switch({ label, checked, disabled, role = "switch", onChange }: { label: string; checked: boolean; disabled?: boolean; role?: "switch" | "checkbox"; onChange(next: boolean): void }) {
  return (
    <button className={`switch ${checked ? "on" : ""}`} role={role} aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)}>
      <i />
    </button>
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
  if (setting.readOnly) return "This device is paired Read only: it can see settings, not change them.";
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
export function SettingRow({ id, title, description, status, control, setting, disabledReason, children }: {
  /** The row's anchor: a search result scrolls here. */
  id?: string;
  title: ReactNode;
  description?: ReactNode;
  status?: ReactNode;
  control?: ReactNode;
  setting?: SettingHandle<never> | SettingHandle<unknown>;
  /** Why the control is off, for a row without a `setting`: it turns inert with this as its tooltip (API 1.13.0). */
  disabledReason?: string | undefined;
  children?: ReactNode;
}) {
  const handle = setting as SettingHandle<unknown> | undefined;
  const inert = Boolean(disabledReason) || (handle !== undefined && !handle.writable);
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
          <div className="settings-row-control" data-inert={inert ? "" : undefined} title={disabledReason ?? (inert ? notWritableReason(handle!) : undefined)}>
            {inert ? <div className="settings-row-control-inert" inert>{control}</div> : control}
          </div>
        ) : null}
      </div>
      {children}
    </div>
  );
}
