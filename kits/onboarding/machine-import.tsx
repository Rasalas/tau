import { useEffect, useMemo, useRef, useState } from "react";
import { errorMessage, type HostExtensionClient, type PlatformEnvironments } from "tau";
import { defaultSessions, importSummary } from "./flow.js";
import { IMPORT_PROGRESS_EVENT, ONBOARDING_EXTENSION_ID, SESSION_SOURCES, type Discovery, type ImportProgress, type ImportResult, type ImportableSession, type MachineImportProps } from "./protocol.js";
import { age } from "./wizard.js";

/** Machines Kit's client (`kits/environments/machine-kit.ts`), copied so kits do not import each other. */
function machineKitClient(environments: PlatformEnvironments, machine: string): HostExtensionClient {
  return {
    invoke: (command, input) => {
      if (!environments.invokeExtension) throw new Error("This window cannot reach kits of other machines.");
      return environments.invokeExtension(machine, ONBOARDING_EXTENSION_ID, command, input, { timeoutMs: 600_000 });
    },
    onEvent: (name, listener) => environments.onExtensionEvent?.(machine, ONBOARDING_EXTENSION_ID, (eventName, payload) => {
      if (eventName === name) listener(payload);
    }) ?? (() => undefined),
  };
}

type ImportState =
  | { kind: "idle" | "listing" }
  | { kind: "listed"; discovery: Discovery }
  | { kind: "importing"; discovery: Discovery; done: number; total: number }
  | { kind: "done"; result: ImportResult }
  | { kind: "error"; message: string };

export function MachineImport({ machine, name, environments }: MachineImportProps & { environments: PlatformEnvironments }) {
  const client = useMemo(() => machineKitClient(environments, machine), [environments, machine]);
  const [state, setState] = useState<ImportState>({ kind: "idle" });
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const generation = useRef(0);
  const progress = useRef<{ source: ImportProgress["source"]; base: number } | undefined>(undefined);
  useEffect(() => {
    setState({ kind: "idle" });
    setSelected(new Set());
    const stop = client.onEvent(IMPORT_PROGRESS_EVENT, (payload) => {
      const event = payload as ImportProgress;
      const current = progress.current;
      if (current?.source !== event.source) return;
      setState((previous) => previous.kind === "importing" ? { ...previous, done: current.base + event.done } : previous);
    });
    return () => { generation.current += 1; progress.current = undefined; stop(); };
  }, [client]);

  const list = () => {
    const current = generation.current;
    setState({ kind: "listing" });
    setSelected(new Set());
    void client.invoke("discover").then(
      (value) => { if (generation.current === current) setState({ kind: "listed", discovery: value as Discovery }); },
      (error: unknown) => { if (generation.current === current) setState({ kind: "error", message: errorMessage(error) }); },
    );
  };
  const discovery = "discovery" in state ? state.discovery : undefined;
  const sessions = discovery?.sessions.filter((session) => !session.imported) ?? [];
  const chosen = sessions.filter((session) => selected.has(session.path));
  const groups = new Map<string, ImportableSession[]>();
  for (const session of sessions) groups.set(session.cwd, [...groups.get(session.cwd) ?? [], session]);
  const importing = state.kind === "importing";
  const toggle = (paths: string[], on: boolean) => setSelected((previous) => new Set(on ? [...previous, ...paths] : [...previous].filter((path) => !paths.includes(path))));
  const run = async () => {
    if (!discovery || importing || chosen.length === 0) return;
    const current = generation.current;
    const result: ImportResult = { imported: 0, skipped: 0, failed: 0 };
    let base = 0;
    setState({ kind: "importing", discovery, done: 0, total: chosen.length });
    for (const { source } of SESSION_SOURCES) {
      const paths = chosen.filter((session) => session.source === source).map((session) => session.path);
      if (!paths.length) continue;
      progress.current = { source, base };
      try {
        const imported = await client.invoke("import-sessions", { source, paths }) as ImportResult;
        if (generation.current !== current) return;
        result.imported += imported.imported;
        result.skipped += imported.skipped;
        result.failed += imported.failed;
      } catch {
        if (generation.current !== current) return;
        result.failed += paths.length;
      }
      base += paths.length;
      setState({ kind: "importing", discovery, done: base, total: chosen.length });
    }
    progress.current = undefined;
    setSelected(new Set());
    setState({ kind: "done", result });
  };

  return <details className="onboarding-optional" onToggle={(event) => { if (event.currentTarget.open && state.kind === "idle") list(); }}>
    <summary>Earlier conversations on {name}</summary>
    {state.kind === "listing" ? <p className="onboarding-note" role="status">Looking for conversations on {name}…</p> : null}
    {state.kind === "error" ? <p className="onboarding-error" role="alert">Could not list conversations. {state.message} <button type="button" className="onboarding-button ghost small" onClick={list}>Retry</button></p> : null}
    {state.kind === "done" ? <><p className="onboarding-note" role="status">{importSummary(state.result)}</p><button type="button" className="onboarding-button ghost small" onClick={list}>List again</button></> : null}
    {discovery ? <>
      <div className="onboarding-selection">
        <span role="status">{chosen.length} of {sessions.length} selected</span>
        <button type="button" className="onboarding-button ghost small" disabled={importing} onClick={() => setSelected(new Set(defaultSessions(sessions, new Set(discovery.projects.map((project) => project.path)), Date.now())))}>Select recent (30 days)</button>
      </div>
      <fieldset className="onboarding-list rows" disabled={importing}>
        <legend className="onboarding-sr">Conversations to import on {name}</legend>
        {sessions.length === 0 ? <p className="onboarding-empty">{discovery.sessions.length ? "Every conversation found is in Tau already." : "No earlier conversations found."}</p> : null}
        {[...groups].map(([cwd, entries]) => {
          const paths = entries.map((session) => session.path);
          const count = paths.filter((path) => selected.has(path)).length;
          return <div key={cwd} className="onboarding-group">
            <label className="onboarding-row" title={cwd}>
              <input type="checkbox" aria-label={`Import conversations in ${cwd}`} checked={count === paths.length} ref={(input) => { if (input) input.indeterminate = count > 0 && count < paths.length; }} onChange={(event) => toggle(paths, event.target.checked)} />
              <span className="onboarding-row-text"><strong>{cwd.split("/").pop() || cwd}</strong><small>{cwd}</small></span>
              <span className="onboarding-count">{entries.length} conversations</span>
            </label>
            {entries.map((session) => <label key={session.path} className="onboarding-row nested">
              <input type="checkbox" checked={selected.has(session.path)} onChange={(event) => toggle([session.path], event.target.checked)} />
              <span className="onboarding-row-text"><span>{session.title || "Untitled conversation"}</span></span>
              <span className="onboarding-meta"><span>{SESSION_SOURCES.find((entry) => entry.source === session.source)?.label}</span><span /><span>{age(session.updatedAt, Date.now())}</span></span>
            </label>)}
          </div>;
        })}
      </fieldset>
      {discovery.truncated ? <p className="onboarding-note" role="status">Scan limit reached. Some conversations may be missing.</p> : null}
      {discovery.unavailable.map((entry) => <p key={entry.source} className="onboarding-note">Could not ask {SESSION_SOURCES.find((source) => source.source === entry.source)?.label}: {entry.reason}</p>)}
      <div className="onboarding-actions"><button type="button" className="onboarding-button primary" disabled={importing || chosen.length === 0} onClick={() => void run()}>
        {state.kind === "importing" ? `Importing… ${state.done} of ${state.total}` : `Import ${chosen.length}`}
      </button></div>
    </> : null}
  </details>;
}
