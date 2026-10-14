import { useMemo, useState, useSyncExternalStore } from "react";
import { Crosshair, Plus, Trash2 } from "lucide-react";
import {
  Button, DangerAction, DangerZone, Empty, READ_ONLY_REASON, SettingRow, SettingsPageAction, SettingsSection, Switch, TextField,
  hostIsReadOnly, type CustomizablePart, type SettingsPageProps,
} from "tau";
import type { CustomizeEdit, CustomizeStore } from "./client-store.js";
import { CUSTOMIZE_EXTENSION_ID, EMPTY_STATE, type CustomizeState, type UserScript, type UserScriptTarget } from "./protocol.js";

export const CUSTOMIZE_SETTINGS_PAGE = "customize";

/** The row a part's name scrolls to: `openSettings("customize#<rowId>")`. */
export function partRowId(name: string): string {
  return `customize-${name.replace(/[^A-Za-z0-9_-]/gu, "_")}`;
}

function newId(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** What a new script starts as: a line fed by Usage's limits, to show the bridge. */
export const SCRIPT_TEMPLATE = `<div id="out" style="font: 12px var(--font-sans); color: var(--muted-foreground); white-space: nowrap">…</div>
<script>
  // Data an extension shares: tau.data(id, callback). Usage shares "tau.usage/limits".
  tau.data("tau.usage/limits", (limits) => {
    const shown = (limits?.accounts ?? []).flatMap((account) =>
      account.windows.map((window) => account.label + " " + window.label + " " + Math.round(window.usedPercent) + "%"));
    document.getElementById("out").textContent = shown.join(" · ") || "No limits yet";
  });
  // tau.openPage("usage", { section: "limits" }) and tau.runCommand(id) answer clicks.
  document.getElementById("out").onclick = () => tau.openPage("usage", { section: "limits" });
</script>`;

export const STYLE_TEMPLATE = `/* Style a part by its name; a part draws no box, so style what it holds. */
[data-tau-part="region:usage.juicebars"] > * {
  opacity: 0.6;
}`;

function describeTarget(target: UserScriptTarget): string {
  return "replace" in target ? `In place of ${target.replace}` : `At ${target.placement}`;
}

function readTarget(text: string, previous: UserScriptTarget): UserScriptTarget {
  const value = text.trim();
  if (!value) return previous;
  // A part name has a colon; anything else is a placement.
  return value.includes(":") ? { replace: value } : { placement: value };
}

export interface CustomizeSettingsProps extends SettingsPageProps {
  store: CustomizeStore;
  parts(): CustomizablePart[];
  subscribeParts(listener: () => void): () => void;
  /** Starts the picker; undefined where there is no pointer to pick with. */
  pick?(): void;
}

/** Settings → Customize: every part with its switch, the user's styles and scripts, and a way back to Tau as shipped. */
export function CustomizeSettings({ store, parts, subscribeParts, pick }: CustomizeSettingsProps) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  useSyncExternalStore(subscribeParts, () => parts().length);
  const readOnly = hostIsReadOnly();
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string>();
  const update = (edit: CustomizeEdit) => { void store.update(edit).then(setError); };

  // Its own parts (the picker, the scripts' regions) are switched by their entries below.
  const all = parts().filter((part) => part.extensionId !== CUSTOMIZE_EXTENSION_ID);
  const shown = useMemo(() => {
    const words = filter.trim().toLowerCase();
    return words ? all.filter((part) => `${part.name} ${part.label} ${part.extensionName}`.toLowerCase().includes(words)) : all;
  }, [all, filter]);
  const groups = useMemo(() => {
    const byExtension = new Map<string, CustomizablePart[]>();
    for (const part of shown) byExtension.set(part.extensionName, [...(byExtension.get(part.extensionName) ?? []), part]);
    return [...byExtension.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [shown]);
  const missing = state.hidden.filter((name) => !all.some((part) => part.name === name));

  const setHidden = (name: string, hidden: boolean) => update((current) => ({
    ...current,
    hidden: hidden ? [...new Set([...current.hidden, name])] : current.hidden.filter((entry) => entry !== name),
  }));
  const addScript = (target: UserScriptTarget, name: string) => update((current) => ({
    ...current,
    scripts: [...current.scripts, { id: newId("script"), name, enabled: true, target, html: SCRIPT_TEMPLATE, revision: 0 }],
  }));
  const editScript = (id: string, patch: Partial<UserScript>) => update((current) => ({
    ...current,
    scripts: current.scripts.map((entry) => entry.id === id ? { ...entry, ...patch } : entry),
  }));
  const replacing = (name: string) => state.scripts.find((script) => "replace" in script.target && script.target.replace === name);

  return (
    <>
      {pick ? <SettingsPageAction><Button icon={<Crosshair size={14} />} onClick={pick}>Pick a part</Button></SettingsPageAction> : null}
      {error ? <p className="customize-error" role="alert">{error}</p> : null}

      <SettingsSection title="Parts">
        <SettingRow title="Find a part" description="Every part extensions draw here, by its name. Turn one off to hide it.">
          <TextField label="Find a part" value={filter} placeholder="usage, juicebars, region:" mono width="md" onChange={setFilter} />
        </SettingRow>
        {groups.length === 0 ? <Empty size="compact" title={filter ? "No part matches." : "No extension draws a part here."} /> : null}
        {groups.map(([extension, entries]) => (
          <div key={extension} className="customize-group">
            <h4 className="customize-group-title">{extension}</h4>
            {entries.map((part) => {
              const script = replacing(part.name);
              return (
                <SettingRow
                  key={part.name}
                  id={partRowId(part.name)}
                  title={part.label}
                  description={<><code>{part.name}</code>{script ? <> · replaced by “{script.name}”</> : null}</>}
                  {...(readOnly ? { disabledReason: READ_ONLY_REASON } : {})}
                  control={<span className="customize-row-controls">
                    {script ? null : <Button variant="ghost" disabled={readOnly} onClick={() => addScript({ replace: part.name }, `${part.label} (mine)`)}>Replace</Button>}
                    <Switch label={`Show ${part.label}`} checked={!part.hidden} disabled={readOnly} onChange={(next) => setHidden(part.name, !next)} />
                  </span>}
                />
              );
            })}
          </div>
        ))}
        {missing.length > 0 ? (
          <SettingRow title="Hidden parts not here" description={<>Hidden, but no extension draws them on this device now: {missing.map((name) => <code key={name}>{name} </code>)}</>}
            control={<Button variant="ghost" disabled={readOnly} onClick={() => update((current) => ({ ...current, hidden: current.hidden.filter((name) => !missing.includes(name)) }))}>Show again</Button>} />
        ) : null}
      </SettingsSection>

      <SettingsSection title="Styles" headerAction={<Button icon={<Plus size={14} />} disabled={readOnly} onClick={() => update((current) => ({ ...current, styles: [...current.styles, { id: newId("style"), name: "My style", css: STYLE_TEMPLATE, enabled: true }] }))}>Add style</Button>}>
        {state.styles.length === 0 ? <Empty size="compact" title="No styles yet" description={<>CSS of your own, on every device of this machine. A part is <code>[data-tau-part="name"]</code>.</>} /> : null}
        {state.styles.map((style) => (
          <div key={style.id} className="customize-entry">
            <SettingRow
              title={<TextField label="Style name" value={style.name} width="md" disabled={readOnly} onCommit={(name) => update((current) => ({ ...current, styles: current.styles.map((entry) => entry.id === style.id ? { ...entry, name } : entry) }))} />}
              control={<span className="customize-row-controls">
                <Switch label={`Use ${style.name}`} checked={style.enabled} disabled={readOnly} onChange={(enabled) => update((current) => ({ ...current, styles: current.styles.map((entry) => entry.id === style.id ? { ...entry, enabled } : entry) }))} />
                <Button variant="ghost" aria-label={`Remove ${style.name}`} icon={<Trash2 size={14} />} disabled={readOnly} onClick={() => update((current) => ({ ...current, styles: current.styles.filter((entry) => entry.id !== style.id) }))} />
              </span>}
            />
            <TextField label={`${style.name} CSS`} value={style.css} rows={10} mono width="full" disabled={readOnly} onCommit={(css) => update((current) => ({ ...current, styles: current.styles.map((entry) => entry.id === style.id ? { ...entry, css } : entry) }))} />
          </div>
        ))}
      </SettingsSection>

      <SettingsSection title="Scripts" headerAction={<Button icon={<Plus size={14} />} disabled={readOnly} onClick={() => addScript({ placement: "title-bar" }, "My script")}>Add script</Button>}>
        {state.scripts.length === 0 ? <Empty size="compact" title="No scripts yet" description={<>HTML and JavaScript in a part's place or at a placement, in a sandbox, on every device. <code>tau.data</code>, <code>tau.openPage</code> and <code>tau.runCommand</code> reach Tau.</>} /> : null}
        {state.scripts.map((script) => (
          <div key={script.id} className="customize-entry">
            <SettingRow
              title={<TextField label="Script name" value={script.name} width="md" disabled={readOnly} onCommit={(name) => editScript(script.id, { name })} />}
              description={describeTarget(script.target)}
              control={<span className="customize-row-controls">
                <Switch label={`Use ${script.name}`} checked={script.enabled} disabled={readOnly} onChange={(enabled) => editScript(script.id, { enabled })} />
                <Button variant="ghost" aria-label={`Remove ${script.name}`} icon={<Trash2 size={14} />} disabled={readOnly} onClick={() => update((current) => ({ ...current, scripts: current.scripts.filter((entry) => entry.id !== script.id) }))} />
              </span>}
            />
            <TextField
              label={`${script.name} target`}
              value={"replace" in script.target ? script.target.replace : script.target.placement}
              placeholder="page:usage/Summary or thread-list-title"
              mono
              width="lg"
              disabled={readOnly}
              onCommit={(text) => editScript(script.id, { target: readTarget(text, script.target) })}
            />
            <TextField label={`${script.name} HTML`} value={script.html} rows={14} mono width="full" disabled={readOnly} onCommit={(html) => editScript(script.id, { html })} />
          </div>
        ))}
      </SettingsSection>

      <DangerZone>
        <DangerAction
          title="Back to Tau as shipped"
          description="Shows every part again and removes your order, moves, styles and scripts on this machine."
          actionLabel="Reset"
          confirmTitle="Reset all customizations?"
          confirmMessage="Every hidden part comes back; your styles and scripts are deleted."
          disabled={readOnly || sameAsShipped(state)}
          {...(readOnly ? { disabledReason: READ_ONLY_REASON } : {})}
          onConfirm={() => update(() => EMPTY_STATE)}
        />
      </DangerZone>
    </>
  );
}

function sameAsShipped(state: CustomizeState): boolean {
  return state.hidden.length === 0 && Object.keys(state.order).length === 0 && Object.keys(state.placement).length === 0 && state.styles.length === 0 && state.scripts.length === 0;
}
