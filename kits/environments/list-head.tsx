import { useEffect, useState, type ComponentType } from "react";
import { TriangleAlert } from "lucide-react";
import type { PlatformEnvironments, UiEnvironment, WorkbenchActions } from "tau";
import { otherMachines, shortAge, shownMachine } from "./machines.js";
import { MachineIcon, useEnvironments } from "./rail.js";

/** "rex not reachable · last seen 12 min ago" (design 2p). */
export function notReachable(machine: UiEnvironment, now: number): string {
  if (machine.status === "refused") return `${machine.name} no longer accepts this device`;
  if (machine.lastSeenAt === undefined) return `${machine.name} not reachable`;
  return `${machine.name} not reachable · last seen ${seenAgo(machine.lastSeenAt, now)}`;
}

function seenAgo(at: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return days < 7 ? `${days} ${days === 1 ? "day" : "days"} ago` : `on ${shortAge(at, now)}`;
}

/** Offline notices are read again this often, for their "last seen". */
const AGE_REFRESH_MS = 30_000;

/**
 * Over a phone's thread list: one line per other machine the phone cannot
 * reach, with Retry, or Pair again for one that refused it; that machine's
 * rows below stay, greyed. Also opens what the page was sent here for.
 */
export function createListHead(environments: PlatformEnvironments, Arrival: ComponentType<{ actions: WorkbenchActions }>) {
  return function MachinesListHead({ actions }: { actions: WorkbenchActions }) {
    const list = useEnvironments(environments);
    const [now, setNow] = useState(() => Date.now());
    const [retrying, setRetrying] = useState<ReadonlySet<string>>(() => new Set());
    useEffect(() => {
      const timer = setInterval(() => setNow(Date.now()), AGE_REFRESH_MS);
      return () => clearInterval(timer);
    }, []);
    const shown = list ? shownMachine(list) : undefined;
    const others = list && shown ? otherMachines(list) : [];
    const away = others.filter((machine) => machine.status === "offline" || machine.status === "refused");
    // The machine on screen is gone: say so once, and offer one that answers (design 2p).
    const [dismissed, setDismissed] = useState(false);
    const elsewhere = shown?.status === "offline" && !dismissed ? others.find((machine) => machine.status === "connected") : undefined;
    const retry = (machine: UiEnvironment) => {
      setRetrying((current) => new Set(current).add(machine.id));
      void environments.retry(machine.id).catch(() => undefined).finally(() => {
        setRetrying((current) => { const next = new Set(current); next.delete(machine.id); return next; });
        setNow(Date.now());
      });
    };
    // Shows that machine; one that refused this device asks to pair again there.
    const show = (machine: UiEnvironment) => {
      void environments.open(machine.id).catch((error: unknown) => actions.notify(error instanceof Error ? error.message : String(error)));
    };
    return <>
      <Arrival actions={actions} />
      {elsewhere ? <div className="machine-elsewhere" role="status">
        <strong>Showing what the phone last saw</strong>
        <span>You can read the threads. Or start on another machine.</span>
        <div>
          <button type="button" onClick={() => show(elsewhere)}><MachineIcon environment={elsewhere} size={15} />Use {elsewhere.name}</button>
          <button type="button" onClick={() => setDismissed(true)}>OK</button>
        </div>
      </div> : null}
      {away.map((machine) => (
        <p key={machine.id} className="machine-notice" data-status={machine.status} role="status">
          <TriangleAlert size={16} aria-hidden />
          <span>{notReachable(machine, now)}</span>
          {machine.status === "refused"
            ? <button type="button" onClick={() => show(machine)}>Pair again</button>
            : <button type="button" disabled={retrying.has(machine.id)} aria-label={`Retry ${machine.name}`} onClick={() => retry(machine)}>{retrying.has(machine.id) ? "Trying…" : "Retry"}</button>}
        </p>
      ))}
    </>;
  };
}

/** Where this host's own threads run, named on their rows while other machines' threads show. */
export function hereOf(environments: PlatformEnvironments) {
  let last: { name: string; icon: ReturnType<typeof MachineIcon> } | undefined;
  return () => {
    const list = environments.getSnapshot();
    const machine = list && list.environments.length > 1 ? shownMachine(list) : undefined;
    if (!machine) return undefined;
    if (last?.name !== machine.name) last = { name: machine.name, icon: <MachineIcon environment={machine} size={12} /> };
    return last;
  };
}
