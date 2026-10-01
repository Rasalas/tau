import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { Laptop, Server } from "lucide-react";
import { Menu, tooltipProps, useThreadStore, type HostExtensionClient, type PlatformEnvironments, type ThreadStore, type UiEnvironment, type UiEnvironmentThread, type UiSession, type WorkbenchActions } from "tau";
import { otherMachines, shownMachine, statusText, unavailableReason } from "./machines.js";
import { AGENTS_EVENT, type AgentMachines, type MachineCardRowProps, type RemoteAgentThreadsService } from "./protocol.js";

const noSubscription = () => () => undefined;
/** Offline machines' reasons say how long ago they were seen; the rail reads them again this often. */
const REASON_REFRESH_MS = 30_000;
/** Thread Rail Kit keeps each machine's pins and settled shelf on that machine (`kits/thread-rail`); a kit never imports another. */
const THREAD_RAIL_EXTENSION_ID = "tau.thread-rail";
const NOTHING_SETTLED: ReadonlySet<string> = new Set();

/** The threads Thread Rail's `state` says are settled. */
export function settledIn(state: unknown): ReadonlySet<string> {
  const threads = state && typeof state === "object" ? (state as { threads?: unknown }).threads : undefined;
  if (!threads || typeof threads !== "object") return NOTHING_SETTLED;
  const settled = new Set<string>();
  for (const [id, meta] of Object.entries(threads as Record<string, unknown>)) {
    if (meta && typeof meta === "object" && typeof (meta as { settledAt?: unknown }).settledAt === "number") settled.add(id);
  }
  return settled;
}

/** Thread Rail's patch that settles a thread, or takes it back (`settlePatch`, `unsettlePatch` in `kits/thread-rail/meta.ts`). */
function settledPatch(settle: boolean, now: number): Record<string, unknown> {
  return settle
    ? { settledAt: now, settledBy: "user", pinned: null, pinOrder: null, order: null, snoozedUntil: null, keptAt: null }
    : { settledAt: null, settledBy: null, order: null, keptAt: now };
}

/** What a machine's thread list was when its settled shelf was read; a new list reads it again. */
function listSignature(machine: UiEnvironment): string {
  return machine.threads.map((thread) => `${thread.id}@${thread.modifiedAt}`).join(",");
}

/** Agents Kit's threads on other machines while that kit is on; the rail leaves them out. */
export const agentThreadsSource = (() => {
  const listeners = new Set<() => void>();
  let service: RemoteAgentThreadsService | undefined;
  let stop: (() => void) | undefined;
  let version = 0;
  const changed = () => { version += 1; for (const listener of [...listeners]) listener(); };
  return {
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getVersion: () => version,
    threadsOn: (machine: string): ReadonlySet<string> | undefined => service?.threadsOn(machine),
    set(next: RemoteAgentThreadsService | undefined) {
      stop?.();
      service = next;
      stop = next?.subscribe(changed);
      changed();
    },
  };
})();

export function useEnvironments(environments: PlatformEnvironments | undefined) {
  return useSyncExternalStore(environments?.subscribe ?? noSubscription, () => environments?.getSnapshot());
}

export function MachineIcon({ environment, size = 13 }: { environment: UiEnvironment; size?: number }) {
  return environment.local ? <Laptop size={size} aria-hidden="true" /> : <Server size={size} aria-hidden="true" />;
}

export function MachineDot({ environment, now }: { environment: UiEnvironment; now: number }) {
  const text = statusText(environment, now);
  return <span className={`machine-dot ${environment.status}`} role="img" aria-label={text} {...tooltipProps(text)} />;
}

/** Another machine's thread as the rail lists it among this machine's (`RailExternalThread` in `kits/workspace/protocol.ts`). */
export interface MachineRailThread {
  key: string;
  session: UiSession;
  running?: boolean;
  /** A question waits there; the phone's list shows it as one. */
  waiting?: boolean;
  opening?: boolean;
  machine: { name: string; icon: ReactNode };
  unavailable?: string;
  /** Settled on its machine, or on this client where it keeps that per machine (the phone app). */
  settled?: boolean;
  open(actions: WorkbenchActions): void;
  lookIn?(actions: WorkbenchActions): void;
  /** Settles it on its machine, or takes it back from the shelf there. */
  toggleSettled?(actions: WorkbenchActions): void;
}

/** The index entry the rail sorts, groups and searches; path and id stay that machine's. */
export function railSession(machine: UiEnvironment, thread: UiEnvironmentThread): UiSession {
  return {
    id: `machine:${machine.id}:${thread.id}`,
    path: thread.path,
    title: thread.title,
    modifiedAt: thread.modifiedAt,
    // No folder here: the rail groups it with this machine's project of the same name.
    projectPath: `${machine.id}:${thread.workspaceId ?? thread.projectName}`,
    projectName: thread.projectName,
    messageCount: 1,
    ...(thread.createdAt !== undefined ? { createdAt: thread.createdAt } : {}),
    ...(thread.projectLabel ? { projectLabel: thread.projectLabel } : {}),
    ...(thread.usage ? { usage: thread.usage } : {}),
    ...(thread.backendKind ? { backendKind: thread.backendKind } : {}),
    ...(thread.modelProvider ? { modelProvider: thread.modelProvider } : {}),
  };
}

/**
 * The other machines' threads for Workspace Kit's rail (ADR 0025): they stand
 * among this machine's by project and time, each with its machine's mark.
 * A thread opens this window there; `lookIn` reads it in a tab
 * here where the core offers that. The machine the window shows has no mark.
 */
export function createMachineThreads(environments: PlatformEnvironments, host?: HostExtensionClient) {
  const listeners = new Set<() => void>();
  let threads: readonly MachineRailThread[] = [];
  let opening: string | undefined;
  let stops: Array<() => void> = [];
  let timer: ReturnType<typeof setInterval> | undefined;
  let builtFrom: { list: unknown; agents: number; own: unknown } | undefined;
  let agents: AgentMachines | undefined;
  let ownThreads: Pick<ThreadStore, "getSnapshot" | "subscribe"> | undefined;
  let stopOwn: (() => void) | undefined;
  let generation = 0;
  // Each machine's settled shelf, read from its Thread Rail Kit, and the list it was read for.
  const shelves = new Map<string, { signature: string; settled: ReadonlySet<string> }>();
  const reading = new Set<string>();

  const readShelf = (machine: UiEnvironment) => {
    const read = environments.readExtension;
    if (!read || machine.status !== "connected" || reading.has(machine.id)) return;
    const signature = listSignature(machine);
    if (shelves.get(machine.id)?.signature === signature) return;
    reading.add(machine.id);
    void read(machine.id, THREAD_RAIL_EXTENSION_ID, "state").then(
      (state) => { shelves.set(machine.id, { signature, settled: settledIn(state) }); },
      // No Thread Rail Kit there, or an older one: nothing is settled there as far as this rail knows.
      () => { shelves.set(machine.id, { signature, settled: shelves.get(machine.id)?.settled ?? NOTHING_SETTLED }); },
    ).finally(() => {
      reading.delete(machine.id);
      changed();
    });
  };

  const toggleSettled = (machine: UiEnvironment, threadId: string, settle: boolean, actions: WorkbenchActions) => {
    const invoke = environments.invokeExtension;
    if (!invoke) return;
    const before = shelves.get(machine.id);
    const settled = new Set(before?.settled ?? NOTHING_SETTLED);
    if (settle) settled.add(threadId); else settled.delete(threadId);
    // Shown at once; the machine's answer is its whole shelf again.
    shelves.set(machine.id, { signature: before?.signature ?? "", settled });
    changed();
    void invoke(machine.id, THREAD_RAIL_EXTENSION_ID, "patch", { patches: { [threadId]: settledPatch(settle, Date.now()) } }).then(
      (state) => { shelves.set(machine.id, { signature: listSignature(machine), settled: settledIn(state) }); },
      (error: unknown) => {
        if (before) shelves.set(machine.id, before); else shelves.delete(machine.id);
        actions.notify(error instanceof Error ? error.message : String(error));
      },
    ).finally(changed);
  };

  const rebuild = () => {
    const list = environments.getSnapshot();
    const own = ownThreads?.getSnapshot().threads;
    builtFrom = { list, agents: agentThreadsSource.getVersion(), own };
    const represented = new Set(own?.flatMap((session) => session.backendKind === "machine" && session.machine ? [session.machine.id] : []));
    for (const machine of agents?.machines ?? []) if (machine.status === "connected") represented.add(machine.id);
    const now = Date.now();
    const next: MachineRailThread[] = [];
    for (const machine of list ? otherMachines(list) : []) {
      // The own index keeps proxy rows across disconnection; do not list them twice then either.
      if (represented.has(machine.id)) continue;
      const reason = unavailableReason(machine, now);
      // Threads this computer's sub-agents run there show in the Agents panel, not here.
      const subagents = agentThreadsSource.threadsOn(machine.id);
      readShelf(machine);
      const shelf = shelves.get(machine.id)?.settled ?? NOTHING_SETTLED;
      const settles = Boolean(environments.invokeExtension && shelves.has(machine.id) && !machine.readOnly);
      for (const thread of machine.threads) {
        if (subagents?.has(thread.id)) continue;
        const session = railSession(machine, thread);
        const settled = Boolean(thread.settled) || shelf.has(thread.id);
        next.push({
          key: session.id,
          session,
          ...(thread.running ? { running: true } : {}),
          ...(thread.waiting ? { waiting: true } : {}),
          ...(settled ? { settled: true } : {}),
          ...(settles ? { toggleSettled: (actions: WorkbenchActions) => toggleSettled(machine, thread.id, !settled, actions) } : {}),
          ...(opening === session.id ? { opening: true } : {}),
          machine: { name: machine.name, icon: <MachineIcon environment={machine} size={13} /> },
          ...(reason ? { unavailable: reason } : {}),
          open: (actions) => {
            opening = session.id;
            changed();
            // The page loads again on that machine; an error leaves this one as it was.
            void environments.open(machine.id, { thread: { path: thread.path } }).catch((error: unknown) => {
              opening = undefined;
              changed();
              actions.notify(error instanceof Error ? error.message : String(error));
            });
          },
          // An older core drops `machine` and would open this machine's thread of that id instead.
          ...(environments.watchThread ? { lookIn: (actions: WorkbenchActions) => actions.openThread(thread.id, { pin: true, machine: machine.id }) } : {}),
        });
      }
    }
    threads = next;
  };
  const changed = () => {
    rebuild();
    for (const listener of [...listeners]) listener();
  };
  const ownChanged = () => { if (builtFrom?.own !== ownThreads?.getSnapshot().threads) changed(); };
  const bindOwnThreads = (store: Pick<ThreadStore, "getSnapshot" | "subscribe">) => {
    if (ownThreads === store) return;
    stopOwn?.();
    ownThreads = store;
    stopOwn = listeners.size > 0 ? store.subscribe(ownChanged) : undefined;
    changed();
  };

  return {
    bindOwnThreads,
    /** Called by the desktop rail and the phone arrival, where the own thread store is in context. */
    useOwnThreads() {
      const store = useThreadStore();
      useEffect(() => { bindOwnThreads(store); }, [store]);
    },
    subscribe(listener: () => void) {
      if (listeners.size === 0) {
        stops = [environments.subscribe(changed), agentThreadsSource.subscribe(changed)];
        stopOwn = ownThreads?.subscribe(ownChanged);
        if (host) {
          const current = ++generation;
          let received = false;
          stops.push(host.onEvent(AGENTS_EVENT, (payload) => {
            received = true;
            if (current !== generation) return;
            agents = payload as AgentMachines;
            changed();
          }));
          void host.invoke("agents").then((payload) => {
            if (current !== generation || received) return;
            agents = payload as AgentMachines;
            changed();
          }, () => undefined);
        }
        timer = setInterval(changed, REASON_REFRESH_MS);
        rebuild();
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size > 0) return;
        for (const stop of stops) stop();
        stops = [];
        generation += 1;
        stopOwn?.();
        stopOwn = undefined;
        clearInterval(timer);
      };
    },
    // The same array until something changed; unwatched, it looks whether the list did.
    threads: () => {
      if (listeners.size === 0 && (builtFrom?.list !== environments.getSnapshot() || builtFrom?.agents !== agentThreadsSource.getVersion() || builtFrom?.own !== ownThreads?.getSnapshot().threads)) rebuild();
      return threads;
    },
  };
}

/** Beside the title bar's link dot, while the window shows another machine: which one, and the way back. */
export function createShownMachine(environments: PlatformEnvironments) {
  return function ShownMachine({ actions }: { actions: WorkbenchActions }) {
    const list = useEnvironments(environments);
    const [open, setOpen] = useState(false);
    const machine = list ? shownMachine(list) : undefined;
    if (!list || !machine || machine.local) return null;
    const local = list.environments.find((environment) => environment.local);
    const back = () => {
      void environments.showLocal().catch((error: unknown) => actions.notify(error instanceof Error ? error.message : String(error)));
    };
    return (
      <span className="menu-anchor">
        <button
          type="button"
          className="machine-shown"
          aria-label={`Showing ${machine.name}`}
          aria-haspopup="menu"
          aria-expanded={open}
          {...tooltipProps(`This window shows ${machine.name}: its threads, files and terminals are that machine's.`, { side: "bottom" })}
          onClick={() => setOpen((value) => !value)}
        >
          <MachineIcon environment={machine} size={13} />
          <span>{machine.name}</span>
          {machine.readOnly ? <em className="machine-badge">Read only</em> : null}
        </button>
        {open ? (
          <Menu
            items={[{
              id: "back",
              label: `Back to ${local?.name ?? "this computer"}`,
              icon: <Laptop size={13} aria-hidden="true" />,
              description: "Shows this computer's threads in the window again",
            }]}
            onSelect={() => { setOpen(false); back(); }}
            onClose={() => setOpen(false)}
          />
        ) : null}
      </span>
    );
  };
}

/** The machine line of a rail row's hover card, for the window's own machine's threads; another machine's row names its own. */
export function createMachineCardRow(environments: PlatformEnvironments) {
  return function MachineCardRow({ session, external, Row }: MachineCardRowProps) {
    const list = useEnvironments(environments);
    if (!external && session?.machine) return <Row icon={<Server size={12} aria-hidden="true" />}>{session.machine.name}</Row>;
    const machine = list ? shownMachine(list) : undefined;
    if (external || !machine) return null;
    return <Row icon={<MachineIcon environment={machine} size={12} />}>{machine.name}</Row>;
  };
}
