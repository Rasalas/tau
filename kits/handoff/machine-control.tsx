import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Laptop, Server } from "lucide-react";
import { Dialog, Menu, tooltipProps, useCommandAllowed, useHostName, useThreadStore, type HostExtensionClient, type RegionProps } from "tau";
import { HANDOFF_EXTENSION_ID, type ContinueTarget } from "./protocol.js";

const RESUME_PROMPT = "Continue the existing task from the transferred context and workspace. Resume the remaining work.";

/** A device change of an existing thread is confirmed, unlike a draft's Run on choice. */
export function createMachineControl(host: HostExtensionClient, move: (threadId: string, target: ContinueTarget, prompt: string, props: RegionProps) => Promise<void>) {
  return function MachineControl(props: RegionProps) {
    const { snapshot, actions } = props;
    const threads = useThreadStore();
    const id = snapshot?.sessionId;
    const thread = useSyncExternalStore((listener) => id ? threads.subscribeToThread(id, listener) : () => undefined, () => id ? threads.getThread(id) : undefined);
    const hostName = useHostName() ?? "This machine";
    const allowed = useCommandAllowed(HANDOFF_EXTENSION_ID, "move-on");
    const [open, setOpen] = useState(false);
    const [targets, setTargets] = useState<readonly ContinueTarget[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string>();
    const [confirm, setConfirm] = useState<{ threadId: string; target: ContinueTarget; prompt: string }>();
    const [busy, setBusy] = useState(false);
    const request = useRef(0);
    useEffect(() => { request.current++; setOpen(false); setConfirm(undefined); }, [id]);
    const name = thread?.machine?.name ?? hostName;
    const backend = thread?.machine?.backendKind ?? snapshot?.backendKind ?? "pi";
    const Icon = thread?.machine ? Server : Laptop;
    const close = () => { setOpen(false); setConfirm(undefined); };
    const choose = () => {
      const revision = ++request.current;
      setOpen(true);
      setLoading(true);
      setError(undefined);
      setTargets([]);
      void host.invoke("continue-targets", { refresh: true, threadId: id }).then((answer) => {
        if (revision === request.current) setTargets(answer as ContinueTarget[]);
      }, (cause: unknown) => { if (revision === request.current) setError(cause instanceof Error ? cause.message : String(cause)); }).finally(() => { if (revision === request.current) setLoading(false); });
    };
    const entries = targets.map((target) => {
      const runtime = target.runtimes?.find((candidate) => candidate.kind === backend);
      const why = target.runtimes && !runtime ? `No ${backend} on ${target.name}.` : runtime && !runtime.ready ? `${runtime.label} is ${runtime.note ?? "not ready"}.` : undefined;
      return { id: target.id, label: target.name, description: why ?? "Move this thread and its workspace here", ...(why ? { disabled: true } : {}) };
    });
    return <span className="menu-anchor workspace-machine-anchor">
      <button type="button" className="workspace-machine-control" aria-label={`Runs on ${name}. Change device`} aria-haspopup="menu" aria-expanded={open} disabled={!id || !allowed || busy} {...tooltipProps(busy ? "Moving thread…" : `Runs on ${name}. Change device`)} onClick={choose}><Icon size={14} aria-hidden /></button>
      {open ? <Menu align="left" heading="Move thread to" items={entries.length ? entries : [{ id: "unavailable", label: loading ? "Checking devices…" : error ?? "No other devices available", disabled: true }]} onClose={() => setOpen(false)} onSelect={(machine) => {
        const target = targets.find((candidate) => candidate.id === machine);
        setOpen(false);
        if (id && target) setConfirm({ threadId: id, target, prompt: actions.composerDraft().trim() || RESUME_PROMPT });
      }} /> : null}
      {confirm ? <Dialog label={`Move thread to ${confirm.target.name}?`} className="handoff-move-dialog" onClose={close}>
        <h2>Move thread to {confirm.target.name}?</h2>
        <p>Tau stops the current turn and transfers the workspace and conversation. After the thread starts there, its saved copy here moves to Archived.</p>
        <p>{backend === "pi" ? "The complete conversation goes along." : `A handoff summary carries the conversation to ${confirm.target.name}.`}</p>
        <label>Continue with<textarea value={confirm.prompt} onChange={(event) => setConfirm({ ...confirm, prompt: event.target.value })} /></label>
        <footer><button type="button" onClick={close}>Cancel</button><button type="button" className="primary" disabled={!confirm.prompt.trim() || actions.activeThread()?.sessionId !== confirm.threadId} onClick={() => {
          const pending = confirm;
          close();
          setBusy(true);
          void move(pending.threadId, pending.target, pending.prompt, props).finally(() => setBusy(false));
        }}>Move to {confirm.target.name}</button></footer>
      </Dialog> : null}
    </span>;
  };
}
