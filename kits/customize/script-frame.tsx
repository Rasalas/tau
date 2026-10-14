import { useEffect, useRef, useState } from "react";
import { SandboxFrame, errorMessage, useColorScheme, type HostExtensionClient, type SandboxFrameHandle, type WorkbenchActions } from "tau";
import { pageTheme } from "../html-pages/theme.js";
import { CUSTOMIZE_COMMANDS, SCRIPT_MESSAGES, type ScriptOpen, type SharedData, type UserScript } from "./protocol.js";

/** Reads a kit's service as shared data; `undefined` when it is not one. */
export type UseShared = (id: string, use: (data: SharedData) => (() => void) | void) => () => void;

interface Message { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown }

function message(data: unknown): Message | undefined {
  return typeof data === "object" && data !== null && (data as Message).jsonrpc === "2.0" ? data as Message : undefined;
}

function param(value: Message, key: string): unknown {
  return typeof value.params === "object" && value.params !== null ? (value.params as Record<string, unknown>)[key] : undefined;
}

function plain(value: unknown): unknown {
  // A snapshot crosses into the frame as JSON: no functions, no class instances.
  try { return JSON.parse(JSON.stringify(value ?? null)) as unknown; } catch { return null; }
}

export interface ScriptFrameProps {
  host: HostExtensionClient;
  script: UserScript;
  actions: WorkbenchActions | undefined;
  useShared: UseShared;
  /** Inside a row: as wide as the script drew and as small as a bar. */
  inline: boolean;
}

/** A user script on the sandbox frame, with the `tau` bridge answered here. */
export function ScriptFrame({ host, script, actions, useShared, inline }: ScriptFrameProps) {
  const scheme = useColorScheme();
  const [open, setOpen] = useState<{ src: string; maxHeight: number } | { error: string } | undefined>();
  const [height, setHeight] = useState<number | undefined>();
  const [width, setWidth] = useState<number | undefined>();
  const handle = useRef<SandboxFrameHandle>(null);
  const subscriptions = useRef(new Map<string, () => void>());
  const latest = useRef({ scheme, actions, useShared });
  latest.current = { scheme, actions, useShared };

  // A new revision is a new document: the frame keeps its first src, so it remounts with the key below.
  useEffect(() => {
    let cancelled = false;
    let minted: string | undefined;
    const release = () => {
      if (minted === undefined) return;
      const path = minted;
      minted = undefined;
      void host.invoke(CUSTOMIZE_COMMANDS.release, { path }).catch(() => undefined);
    };
    setOpen(undefined);
    host.invoke(CUSTOMIZE_COMMANDS.openScript, { id: script.id, colorScheme: latest.current.scheme, theme: pageTheme(), inline }).then((answer) => {
      const result = answer as ScriptOpen;
      if (result.state === "ready") minted = result.path;
      if (cancelled) { release(); return; }
      if (result.state === "missing") { setOpen({ error: "This script is gone." }); return; }
      if (!host.resourceUrl) { release(); setOpen({ error: "This client cannot show scripts." }); return; }
      setOpen({ src: host.resourceUrl(result.path), maxHeight: result.maxHeight });
    }, (error: unknown) => { if (!cancelled) setOpen({ error: errorMessage(error) }); });
    return () => { cancelled = true; release(); };
  }, [host, script.id, script.revision, inline]);

  useEffect(() => () => {
    for (const stop of subscriptions.current.values()) stop();
    subscriptions.current.clear();
  }, [script.id, script.revision]);

  const onMessage = (data: unknown) => {
    const value = message(data);
    if (!value || typeof value.method !== "string") return;
    const { actions: current, useShared: use } = latest.current;
    switch (value.method) {
      case SCRIPT_MESSAGES.size: {
        const next = param(value, "height");
        if (typeof next === "number" && Number.isFinite(next) && next > 0) setHeight(Math.ceil(next));
        return;
      }
      case SCRIPT_MESSAGES.width: {
        const next = param(value, "width");
        if (typeof next === "number" && Number.isFinite(next) && next > 0) setWidth(Math.ceil(next));
        return;
      }
      case SCRIPT_MESSAGES.subscribe: {
        const id = param(value, "id");
        if (typeof id !== "string" || subscriptions.current.has(id)) return;
        const send = (snapshot: unknown) => handle.current?.post({ jsonrpc: "2.0", method: SCRIPT_MESSAGES.data, params: { id, value: plain(snapshot) } });
        subscriptions.current.set(id, use(id, (shared) => {
          send(shared.getSnapshot());
          return shared.subscribe(() => send(shared.getSnapshot()));
        }));
        return;
      }
      case SCRIPT_MESSAGES.unsubscribe: {
        const id = param(value, "id");
        if (typeof id !== "string") return;
        subscriptions.current.get(id)?.();
        subscriptions.current.delete(id);
        return;
      }
      case SCRIPT_MESSAGES.openPage: {
        const id = param(value, "id");
        const params = param(value, "params");
        if (typeof id === "string") current?.openPage?.(id, typeof params === "object" && params !== null ? params as Record<string, unknown> : {});
        return;
      }
      case SCRIPT_MESSAGES.runCommand: {
        // A command may change things: only from a click in the script.
        const id = param(value, "id");
        if (typeof id !== "string" || !current?.executeCommand || !handle.current?.hasUserActivation()) return;
        void Promise.resolve(current.executeCommand(id)).catch((error: unknown) => current.notify(errorMessage(error), "error"));
        return;
      }
      case SCRIPT_MESSAGES.link: {
        const url = param(value, "url");
        const allowed = Boolean(handle.current?.hasUserActivation()) && typeof url === "string" && /^https?:\/\//iu.test(url);
        if (allowed) current?.openExternal(url);
        if (typeof value.id === "string" || typeof value.id === "number") {
          handle.current?.post(allowed
            ? { jsonrpc: "2.0", id: value.id, result: {} }
            : { jsonrpc: "2.0", id: value.id, error: { code: -32000, message: "Links open only from a click in the script." } });
        }
        return;
      }
      default:
    }
  };

  if (!open) return null;
  if ("error" in open) return <span className="customize-script-error" title={open.error}>{script.name}: {open.error}</span>;
  const frameHeight = Math.min(height ?? (inline ? 24 : 80), open.maxHeight);
  return (
    <div className="customize-script" data-inline={inline ? "" : undefined} style={inline && width ? { width } : undefined}>
      <SandboxFrame
        key={`${script.id}:${String(script.revision)}`}
        src={open.src}
        title={script.name}
        height={frameHeight}
        minHeight={1}
        onMessage={onMessage}
        handleRef={handle}
      />
    </div>
  );
}
