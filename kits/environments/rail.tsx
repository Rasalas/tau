import { useEffect, useState, useSyncExternalStore, type CSSProperties } from "react";
import { ChevronRight, Laptop, Plus, RefreshCw, Server } from "lucide-react";
import { Menu, tooltipProps, type PlatformEnvironments, type UiEnvironment, type UiEnvironmentThread, type WorkbenchActions } from "tau";
import { otherMachines, shownMachine, shortAge, statusText, unavailableReason } from "./machines.js";
import { MACHINES_SETTINGS_PAGE } from "./protocol.js";

const FIRST_ROWS = 3;
const MORE_ROWS = 10;
const noSubscription = () => () => undefined;

function projectHue(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) hash = (hash * 31 + value.charCodeAt(index)) | 0;
  return Math.abs(hash) % 360;
}

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

function MachineThreadRow({ thread, machine, reason, opening, onOpen, now }: {
  thread: UiEnvironmentThread;
  machine: UiEnvironment;
  reason: string | undefined;
  opening: boolean;
  onOpen(): void;
  now: number;
}) {
  const style = { "--project-hue": projectHue(thread.projectName) } as CSSProperties;
  return (
    <article className={`thread-row compact machine-thread${reason ? " unavailable" : ""}`}>
      <button
        className="thread-main"
        aria-disabled={reason ? true : undefined}
        aria-label={`${thread.title} on ${machine.name}`}
        onClick={() => { if (!reason && !opening) onOpen(); }}
        {...tooltipProps(reason ?? `${thread.title}\n${thread.projectName} · on ${machine.name}`, { side: "right", variant: "lines" })}
      >
        <i className="thread-project-icon" style={style}>{thread.projectName.trim().charAt(0).toUpperCase() || "·"}</i>
        <span className="thread-title">{thread.title}</span>
        {thread.running ? <span className="machine-thread-working" aria-label="Working"><i /></span> : null}
        {opening ? <span className="machine-thread-opening">Opening…</span> : <time>{shortAge(thread.modifiedAt, now)}</time>}
      </button>
    </article>
  );
}

function MachineGroup({ machine, environments, actions, now }: {
  machine: UiEnvironment;
  environments: PlatformEnvironments;
  actions: WorkbenchActions;
  now: number;
}) {
  const [open, setOpen] = useState(true);
  const [limit, setLimit] = useState(FIRST_ROWS);
  const [opening, setOpening] = useState<string>();
  const reason = unavailableReason(machine, now);
  const openThread = (thread: UiEnvironmentThread) => {
    setOpening(thread.id);
    // The page loads again on that machine; an error leaves this one as it was.
    void environments.open(machine.id, { thread: { path: thread.path } }).catch((error: unknown) => {
      setOpening(undefined);
      actions.notify(error instanceof Error ? error.message : String(error));
    });
  };
  const retry = machine.status === "offline" || machine.status === "refused";
  const shown = machine.threads.slice(0, limit);
  return (
    <div className={`machine-group status-${machine.status}`}>
      <div className="machine-head">
        <button className="machine-toggle" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
          <ChevronRight size={12} className="chev" aria-hidden="true" />
          <MachineIcon environment={machine} />
          <span className="machine-name">{machine.name}</span>
          {machine.readOnly ? <em className="machine-badge">Read only</em> : null}
        </button>
        <MachineDot environment={machine} now={now} />
        {retry ? (
          <button className="sidebar-action machine-retry" aria-label={`Try ${machine.name} again`} {...tooltipProps(`Try ${machine.name} again`)} onClick={() => void environments.retry(machine.id)}>
            <RefreshCw size={12} />
          </button>
        ) : null}
      </div>
      {open ? (
        <div className="machine-threads">
          {shown.map((thread) => (
            <MachineThreadRow
              key={thread.id}
              thread={thread}
              machine={machine}
              reason={reason}
              opening={opening === thread.id}
              onOpen={() => openThread(thread)}
              now={now}
            />
          ))}
          {machine.threads.length > limit ? (
            <article className="thread-row compact thread-pagination-row">
              <button className="thread-main" onClick={() => setLimit((current) => current + MORE_ROWS)}>+ show {Math.min(MORE_ROWS, machine.threads.length - limit)} more</button>
            </article>
          ) : null}
          {machine.threads.length === 0 ? (
            <p className="machine-empty">{machine.status === "connected" ? "No threads yet" : reason}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The other machines' threads at the foot of the rail (ADR 0025). This
 * machine's threads are the rail above; a thread of another machine opens
 * this window there.
 */
export function createMachinesRailSection(environments: PlatformEnvironments) {
  return function MachinesRailSection({ actions }: { actions: WorkbenchActions }) {
    const list = useEnvironments(environments);
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
      const timer = window.setInterval(() => setNow(Date.now()), 30_000);
      return () => window.clearInterval(timer);
    }, []);
    const machines = list ? otherMachines(list) : [];
    // One machine is the everyday case; the rail stays as it was until another is added.
    if (machines.length === 0) return null;
    return (
      <section className="machines-rail" aria-label="Other machines">
        <div className="machines-rail-head">
          <span>Other machines</span>
          <button className="sidebar-action" aria-label="Add a machine" {...tooltipProps("Add a machine")} onClick={() => actions.openSettings(MACHINES_SETTINGS_PAGE)}>
            <Plus size={13} />
          </button>
        </div>
        <div className="machines-rail-list">
          {machines.map((machine) => <MachineGroup key={machine.id} machine={machine} environments={environments} actions={actions} now={now} />)}
        </div>
      </section>
    );
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
