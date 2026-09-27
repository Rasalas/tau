import { useState, useSyncExternalStore, type ReactNode } from "react";
import { Laptop, Server } from "lucide-react";
import { Menu, tooltipProps, type PlatformEnvironments, type UiEnvironment, type UiEnvironmentThread, type UiSession, type WorkbenchActions } from "tau";
import { otherMachines, shownMachine, statusText, unavailableReason } from "./machines.js";
import type { RemoteAgentThreadsService } from "./protocol.js";

const noSubscription = () => () => undefined;
/** Offline machines' reasons say how long ago they were seen; the rail reads them again this often. */
const REASON_REFRESH_MS = 30_000;

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
  opening?: boolean;
  machine: { name: string; icon: ReactNode };
  unavailable?: string;
  open(actions: WorkbenchActions): void;
  lookIn?(actions: WorkbenchActions): void;
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
 * among this machine's by project and time, each with its machine's mark, as
 * in T3 Code. A thread opens this window there; `lookIn` reads it in a tab
 * here where the core offers that. The machine the window shows has no mark.
 */
export function createMachineThreads(environments: PlatformEnvironments) {
  const listeners = new Set<() => void>();
  let threads: readonly MachineRailThread[] = [];
  let opening: string | undefined;
  let stops: Array<() => void> = [];
  let timer: ReturnType<typeof setInterval> | undefined;
  let builtFrom: { list: unknown; agents: number } | undefined;

  const rebuild = () => {
    const list = environments.getSnapshot();
    builtFrom = { list, agents: agentThreadsSource.getVersion() };
    const now = Date.now();
    const next: MachineRailThread[] = [];
    for (const machine of list ? otherMachines(list) : []) {
      const reason = unavailableReason(machine, now);
      // Threads this computer's sub-agents run there show in the Agents panel, not here.
      const agents = agentThreadsSource.threadsOn(machine.id);
      for (const thread of machine.threads) {
        if (agents?.has(thread.id)) continue;
        const session = railSession(machine, thread);
        next.push({
          key: session.id,
          session,
          ...(thread.running ? { running: true } : {}),
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

  return {
    subscribe(listener: () => void) {
      if (listeners.size === 0) {
        stops = [environments.subscribe(changed), agentThreadsSource.subscribe(changed)];
        timer = setInterval(changed, REASON_REFRESH_MS);
        rebuild();
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size > 0) return;
        for (const stop of stops) stop();
        stops = [];
        clearInterval(timer);
      };
    },
    // The same array until something changed; unwatched, it looks whether the list did.
    threads: () => {
      if (listeners.size === 0 && (builtFrom?.list !== environments.getSnapshot() || builtFrom?.agents !== agentThreadsSource.getVersion())) rebuild();
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
