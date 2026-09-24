import { useEffect, useState, type FormEvent } from "react";
import { ConfirmDialog, SettingsSection, errorMessage, type PlatformEnvironments, type UiEnvironment } from "tau";
import { formatDigits, statusText } from "./machines.js";
import { MachineDot, MachineIcon, useEnvironments } from "./rail.js";

function MachineRow({ machine, shown, environments, now, onRemove }: {
  machine: UiEnvironment;
  shown: boolean;
  environments: PlatformEnvironments;
  now: number;
  onRemove(): void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(machine.name);
  const details = [
    machine.local ? "This computer" : machine.address?.replace(/^wss?:\/\//u, "").replace(/\/$/u, ""),
    statusText(machine, now),
    machine.hostVersion ? `Tau ${machine.hostVersion}` : undefined,
    machine.threadCount ? `${machine.threadCount} thread${machine.threadCount === 1 ? "" : "s"}` : undefined,
  ].filter(Boolean);
  const save = (event: FormEvent) => {
    event.preventDefault();
    const next = name.trim();
    setEditing(false);
    if (next && next !== machine.name) void environments.rename(machine.id, next);
  };
  return (
    <div className="connection-row machine-row">
      <MachineDot environment={machine} now={now} />
      <div className="connection-row-text">
        {editing ? (
          <form onSubmit={save}>
            <input className="settings-input" value={name} maxLength={80} autoFocus aria-label={`Name for ${machine.name}`} onChange={(event) => setName(event.target.value)} onBlur={save} />
          </form>
        ) : (
          <strong>
            <MachineIcon environment={machine} />
            {machine.name}
            {shown ? <em className="connection-badge">Shown here</em> : null}
            {machine.readOnly ? <em className="connection-badge">Read only</em> : null}
          </strong>
        )}
        <small title={machine.detail}>{details.join(" · ")}</small>
      </div>
      {machine.local ? null : (
        <>
          {machine.status === "offline" || machine.status === "refused" ? (
            <button type="button" className="chrome-button" onClick={() => void environments.retry(machine.id)}>Try again</button>
          ) : null}
          <button type="button" className="chrome-button" onClick={() => { setName(machine.name); setEditing(true); }}>Rename</button>
          <button type="button" className="chrome-button danger" onClick={onRemove}>Remove</button>
        </>
      )}
    </div>
  );
}

type AddState =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "done"; message: string; tone: "ok" | "problem" };

function AddMachine({ environments, busyElsewhere }: { environments: PlatformEnvironments; busyElsewhere: boolean }) {
  const [text, setText] = useState("");
  const [state, setState] = useState<AddState>({ kind: "idle" });
  const list = useEnvironments(environments);
  const pairing = list?.pairing;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!text.trim() || state.kind === "busy") return;
    setState({ kind: "busy" });
    void environments.pair({ text }).then((result) => {
      if (result.state === "added") {
        setText("");
        setState({ kind: "done", tone: "ok", message: `${result.environment.name} was added. Its threads are listed at the foot of the thread rail.` });
      } else if (result.state === "denied") {
        setState({ kind: "done", tone: "problem", message: "The other machine's owner declined." });
      } else if (result.state === "expired") {
        setState({ kind: "done", tone: "problem", message: "Nobody answered on the other machine in time. Try again and allow it there." });
      } else if (result.state === "cancelled") {
        setState({ kind: "idle" });
      } else if (result.state === "failed") {
        setState({ kind: "done", tone: "problem", message: result.message });
      }
    }, (error: unknown) => setState({ kind: "done", tone: "problem", message: errorMessage(error) }));
  };
  const busy = state.kind === "busy" || busyElsewhere;
  return (
    <form className="machine-add" onSubmit={submit}>
      <label className="machine-add-field">
        <span>Pairing link or address</span>
        <input
          className="settings-input"
          value={text}
          disabled={busy}
          placeholder="https://studio.local:7788/#pair=… or studio.local:7788"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          onChange={(event) => setText(event.target.value)}
        />
      </label>
      {pairing ? (
        <div className="machine-pairing" role="status" aria-live="polite">
          {pairing.state === "waiting" && pairing.verification ? (
            <>
              <strong>Allow this computer on the other machine</strong>
              <p>Its window asks now. Allow it only if it shows the same code:</p>
              <code className="machine-pairing-code">{formatDigits(pairing.verification)}</code>
            </>
          ) : (
            <p>Connecting to {pairing.address}…</p>
          )}
          <button type="button" className="text-button" onClick={() => void environments.cancelPairing()}>Cancel</button>
        </div>
      ) : null}
      {state.kind === "done" ? <p className={`machine-add-result ${state.tone}`} role="status">{state.message}</p> : null}
      <div className="machine-add-actions">
        <button type="submit" className="primary" disabled={busy || !text.trim()}>{busy ? "Waiting…" : "Add machine"}</button>
      </div>
    </form>
  );
}

/**
 * Settings → Machines: the computers this window shows threads of, and adding
 * one. Adding one asks that machine's owner, who compares a code (ADR 0024).
 */
export function createMachinesPage(environments: PlatformEnvironments) {
  return function MachinesPage() {
    const list = useEnvironments(environments);
    const [now, setNow] = useState(() => Date.now());
    const [removing, setRemoving] = useState<UiEnvironment>();
    useEffect(() => {
      const timer = window.setInterval(() => setNow(Date.now()), 15_000);
      return () => window.clearInterval(timer);
    }, []);
    if (!list) {
      return (
        <div className="settings-page">
          <SettingsSection title="Machines">
            <p className="settings-group-note">This window keeps no list of machines. A desktop window beside its own host does.</p>
          </SettingsSection>
        </div>
      );
    }
    return (
      <div className="settings-page machines-page">
        <SettingsSection title="Machines">
          {list.environments.map((machine) => (
            <MachineRow key={machine.id} machine={machine} shown={machine.id === list.shown} environments={environments} now={now} onRemove={() => setRemoving(machine)} />
          ))}
        </SettingsSection>
        <SettingsSection title="Add a machine">
          <p className="settings-group-note">
            On the other computer, open Settings → Connections, turn on network access and create a pairing link; paste it here,
            or type that computer's address. Its owner allows this computer there after comparing a code. Its threads then show
            beside this computer's, and a new thread can start on it.
          </p>
          {list.secureStorage ? null : (
            <p className="settings-group-note machine-warning">This computer offers Tau no encrypted storage (keychain or secret service), so it cannot keep another machine's key.</p>
          )}
          <AddMachine environments={environments} busyElsewhere={!list.secureStorage} />
        </SettingsSection>
        {removing ? (
          <ConfirmDialog
            title={`Remove ${removing.name}?`}
            message="This computer forgets the machine and its key. Its threads stay on it; add it again to see them here."
            confirmLabel="Remove"
            destructive
            onConfirm={() => {
              const id = removing.id;
              setRemoving(undefined);
              void environments.remove(id);
            }}
            onCancel={() => setRemoving(undefined)}
          />
        ) : null}
      </div>
    );
  };
}
