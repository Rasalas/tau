import { useEffect, useSyncExternalStore } from "react";
import { Button, NumberField, SettingRow, TextField } from "tau";
import type { TerminalFontService, TerminalFontServiceState, TerminalFontSource } from "./protocol.js";

/** The Terminal Kit's font service while it is there; the page follows it coming and going. */
export class TerminalFontLink {
  private service: TerminalFontService | undefined;
  private readonly listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getSnapshot = (): TerminalFontService | undefined => this.service;

  /** For `useService`: holds the service and lets go of it when it is withdrawn. */
  connect(service: TerminalFontService): () => void {
    this.service = service;
    this.emit();
    return () => {
      if (this.service !== service) return;
      this.service = undefined;
      this.emit();
    };
  }

  private emit(): void {
    this.listeners.forEach((listener) => listener());
  }
}

const SOURCE: Record<TerminalFontSource, string> = {
  settings: "set here",
  ghostty: "from your Ghostty config",
  default: "platform default",
};

/** A config file's name; the full path, which names the user's home, goes in the tooltip. */
function fileName(path: string): string {
  return path.split(/[\\/]/u).filter(Boolean).at(-1) ?? path;
}

const SAMPLE = "~/project $ ls -la  0O 1lI {}[] ┌─┐";

/** The size a field holds, if it is one the terminal draws: a number in range, to the half pixel. */
export function terminalSizeInput(text: string, range: { min: number; max: number }): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return "";
  const size = Number(trimmed);
  if (!Number.isFinite(size) || size < range.min || size > range.max || Math.round(size * 2) !== size * 2) return undefined;
  return String(size);
}

function Fields({ state, service }: { state: TerminalFontServiceState; service: TerminalFontService }) {
  return <>
    <TextField label="Terminal font family" width="md" placeholder={state.ghostty?.face ?? "SF Mono, Menlo"} value={state.family}
      onCommit={(family) => { if (family.trim() !== state.family) service.set({ family }); }} />
    <NumberField label="Terminal font size" value={state.size ? Number(state.size) : undefined} min={state.sizeRange.min} max={state.sizeRange.max} step={0.5} unit="px"
      placeholder={String(state.ghostty?.size ?? state.resolved.size)}
      validate={(value) => (terminalSizeInput(String(value), state.sizeRange) === undefined ? "Use whole or half pixels." : undefined)}
      onCommit={(value) => { if (String(value) !== state.size) service.set({ size: String(value) }); }}
      onClear={() => { if (state.size) service.set({ size: "" }); }} />
    {state.family || state.size ? <Button onClick={() => service.set({ family: "", size: "" })}>Reset</Button> : null}
  </>;
}

function TerminalFontFields({ service }: { service: TerminalFontService }) {
  const state = useSyncExternalStore(service.subscribe, service.getSnapshot);
  // The Ghostty config may have changed since the terminal first read it.
  useEffect(() => { void service.refresh().catch(() => undefined); }, [service]);
  const { resolved, ghostty } = state;
  return <SettingRow
    id="setting-appearance-terminal-font"
    title="Terminal font"
    description="Terminal output in the panel, the drawer and terminal tabs, apart from code blocks and diffs. Empty fields follow your Ghostty config, then the platform's monospace faces."
    status={<>
      <span role="status">{resolved.face ?? "SF Mono"} ({SOURCE[resolved.familySource]}) at {resolved.size}px ({SOURCE[resolved.sizeSource]}).</span>
      {ghostty && ghostty.files.length > 0 ? <> Ghostty config: {ghostty.files.map((file, index) => <span key={file}>{index > 0 ? ", " : ""}<code title={file}>{fileName(file)}</code></span>)}.</> : null}
      {ghostty?.problems.map((problem) => <span key={problem} className="appearance-terminal-problem"> {problem}</span>)}
    </>}
    control={<Fields state={state} service={service} />}
  >
    <div className="appearance-terminal-sample" aria-hidden style={{ fontFamily: resolved.stack, fontSize: `${resolved.size}px` }}>{SAMPLE}</div>
  </SettingRow>;
}

/** Settings → Appearance's terminal row; nothing while the Terminal Kit is off. */
export function TerminalFontRow({ link }: { link: TerminalFontLink }) {
  const service = useSyncExternalStore(link.subscribe, link.getSnapshot);
  return service ? <TerminalFontFields service={service} /> : null;
}
