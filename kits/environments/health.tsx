import { useEffect, useState } from "react";
import { ProviderIconStack, errorMessage, type HostExtensionClient, type HostReadiness, type HostResources } from "tau";
import { readinessFacts, resourcesText, runtimeText } from "./machines.js";

type Load<T> = { state: "loading" } | { state: "done"; value: T } | { state: "failed"; message: string };

/**
 * How busy a machine is and what it could run, asked through this computer's
 * host when the row shows and on "Check again"; nothing is polled (plan H §7).
 * Runtimes are marks, their state in the tooltip.
 */
export function MachineHealth({ host, machine, name }: { host: HostExtensionClient; machine: string; name: string }) {
  const [resources, setResources] = useState<Load<HostResources>>({ state: "loading" });
  const [readiness, setReadiness] = useState<Load<HostReadiness>>({ state: "loading" });
  const [round, setRound] = useState(0);
  useEffect(() => {
    let live = true;
    const load = <T,>(command: string, set: (value: Load<T>) => void) => {
      set({ state: "loading" });
      host.invoke(command, { machine }).then(
        (value) => { if (live) set({ state: "done", value: value as T }); },
        (error: unknown) => { if (live) set({ state: "failed", message: errorMessage(error) }); },
      );
    };
    load("resources", setResources);
    load("readiness", setReadiness);
    return () => { live = false; };
  }, [host, machine, round]);
  const busy = resources.state === "loading" || readiness.state === "loading";
  const ready = readiness.state === "done" ? readiness.value.runtimes.filter((runtime) => runtime.state === "ready").length : 0;
  return (
    <div className="machine-health" role="group" aria-label={`How ${name} is doing`} aria-busy={busy}>
      <div className="machine-health-line">
        <small className={resources.state === "failed" ? "problem" : undefined}>
          {resources.state === "done" ? resourcesText(resources.value) : resources.state === "loading" ? "Measuring load…" : `Load unknown: ${resources.message}`}
        </small>
        <button type="button" className="text-button" disabled={busy} onClick={() => setRound((value) => value + 1)}>Check again</button>
      </div>
      {readiness.state === "done" ? (
        <div className="machine-health-line">
          <ul className="machine-runtimes" aria-label="Runtimes">
            {readiness.value.runtimes.map((runtime) => (
              <li key={runtime.kind} className={`machine-runtime ${runtime.state}`} title={runtime.note}>
                <ProviderIconStack runtimeProvider={runtime.kind} name={runtimeText(runtime)} />
              </li>
            ))}
          </ul>
          <small>
            {[`${ready} of ${readiness.value.runtimes.length} ready`, ...readinessFacts(readiness.value).map((fact) => fact.text)].join(" · ")}
          </small>
        </div>
      ) : (
        <small className={readiness.state === "failed" ? "problem" : undefined}>
          {readiness.state === "loading" ? "Checking what it can run…" : `Readiness unknown: ${readiness.message}`}
        </small>
      )}
      {readiness.state === "done" ? <FactProblems readiness={readiness.value} /> : null}
    </div>
  );
}

/** The facts that keep work from moving there, spelled out. */
function FactProblems({ readiness }: { readiness: HostReadiness }) {
  const problems = readinessFacts(readiness).filter((fact) => fact.problem);
  if (problems.length === 0) return null;
  return <small className="problem">{problems.map((fact) => fact.problem).join(" ")}</small>;
}
