import { useEffect, useState, useSyncExternalStore } from "react";
import type { UiSession } from "tau";
import {
  WAKE_PATCH,
  dropLabel,
  dropPatches,
  pinPatch,
  railSections,
  sectionOf,
  settlePatch,
  snoozePatch,
  snoozePresets,
  unsettlePatch,
  type RailDrop,
} from "./meta.js";
import type { RailOrganizer, RailSections, ThreadMetaPatch } from "./protocol.js";
import type { RailStore } from "./store.js";

export type SendPatches = (patches: Record<string, ThreadMetaPatch | null>) => void;

const EMPTY: RailSections = { pinned: [], active: [], snoozed: [], settled: [] };

/** The rail as Thread Rail sees it: four sections, the row menu, drops and the snooze dialog. */
export function createRailOrganizer(store: RailStore, send: SendPatches, now: () => number = Date.now): RailOrganizer & {
  /** Pin or unpin, settle or un-settle, by thread id; the commands' way in. */
  togglePin(threadId: string): void;
  toggleSettledById(threadId: string): void;
  snooze(threadId: string, until: number): void;
} {
  let last: RailSections = EMPTY;
  const meta = (threadId: string) => store.getState().threads[threadId];

  const togglePin = (threadId: string) => send({ [threadId]: pinPatch(store.getState(), threadId, !meta(threadId)?.pinned, now()) });
  const toggleSettledById = (threadId: string) => send({
    [threadId]: meta(threadId)?.settledAt !== undefined ? unsettlePatch(now()) : settlePatch(now(), "user"),
  });
  const snooze = (threadId: string, until: number) => send({ [threadId]: snoozePatch(until) });
  const drop = (threadId: string, target: RailDrop) => {
    const patches = dropPatches(store.getState(), last, threadId, target, now());
    if (patches) send(patches);
  };
  /** One step up or down within the thread's own section. */
  const step = (threadId: string, direction: -1 | 1) => {
    const section = sectionOf(meta(threadId), now());
    if (section !== "pinned" && section !== "active") return;
    const list = last[section].map((thread) => thread.id);
    const index = list.indexOf(threadId);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= list.length) return;
    const without = list.filter((id) => id !== threadId);
    drop(threadId, { sectionId: section, ...(without[target] ? { beforeThreadId: without[target] } : {}) });
  };

  function Layer() {
    useSyncExternalStore(store.subscribe, store.getVersion);
    const session = store.snoozeDialogFor;
    if (!session) return null;
    return (
      <SnoozeDialog
        key={session.id}
        session={session}
        now={now}
        onClose={() => store.openSnooze(undefined)}
        onSnooze={(until) => { snooze(session.id, until); store.openSnooze(undefined); }}
      />
    );
  }

  return {
    subscribe: store.subscribe,
    getVersion: store.getVersion,
    sections(threads) {
      last = railSections(threads, store.getState(), now());
      store.displayed = [...last.pinned, ...last.active];
      return [
        { id: "pinned", label: "PINNED", threads: last.pinned },
        { id: "active", threads: last.active },
        { id: "snoozed", label: "SNOOZED", shelf: true, collapsed: true, threads: last.snoozed },
        { id: "settled", label: "SETTLED", shelf: true, settled: true, threads: last.settled },
      ];
    },
    menu(session) {
      const current = meta(session.id);
      const section = sectionOf(current, now());
      if (section === "settled") {
        return [{ items: [{ id: "unsettle", label: "Un-settle thread" }, { id: "pin", label: "Pin thread" }] }];
      }
      const snoozed = section === "snoozed";
      return [
        { items: [current?.pinned ? { id: "unpin", label: "Unpin thread" } : { id: "pin", label: "Pin thread" }] },
        {
          heading: "SNOOZE",
          items: snoozed
            ? [{ id: "wake", label: "Wake thread" }, { id: "snooze:custom", label: "Snooze until…" }]
            : [...snoozePresets(new Date(now())).map(({ id, label }) => ({ id, label })), { id: "snooze:custom", label: "Custom…" }],
        },
        {
          items: [
            { id: "settle", label: "Settle thread" },
            ...(snoozed ? [] : [{ id: "move-up", label: "Move up" }, { id: "move-down", label: "Move down" }]),
          ],
        },
      ];
    },
    runMenu(session, itemId) {
      if (itemId === "pin" || itemId === "unpin") togglePin(session.id);
      else if (itemId === "settle" || itemId === "unsettle") toggleSettledById(session.id);
      else if (itemId === "wake") send({ [session.id]: WAKE_PATCH });
      else if (itemId === "snooze:custom") store.openSnooze(session);
      else if (itemId === "move-up") step(session.id, -1);
      else if (itemId === "move-down") step(session.id, 1);
      else {
        const preset = snoozePresets(new Date(now())).find((entry) => entry.id === itemId);
        if (preset) snooze(session.id, preset.until);
      }
    },
    toggleSettled: (session) => toggleSettledById(session.id),
    dropLabel: (threadId, target) => dropLabel(sectionOf(meta(threadId), now()), target.sectionId),
    drop,
    Layer,
    togglePin,
    toggleSettledById,
    snooze,
  };
}

type Unit = "minutes" | "hours" | "days";
const UNIT_MS: Record<Unit, number> = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 };

/** `YYYY-MM-DDTHH:mm` in local time, what a datetime-local field reads and writes. */
function localInput(epoch: number): string {
  const date = new Date(epoch);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** A duration starts when the user confirms; a date is read in local time. */
export function SnoozeDialog({ session, now, onClose, onSnooze }: {
  session: UiSession;
  now: () => number;
  onClose(): void;
  onSnooze(until: number): void;
}) {
  const [mode, setMode] = useState<"duration" | "date">("duration");
  const [amount, setAmount] = useState("1");
  const [unit, setUnit] = useState<Unit>("hours");
  const [date, setDate] = useState(() => localInput(snoozePresets(new Date(now()))[1]!.until));
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);
  const until = mode === "duration" ? now() + Number(amount) * UNIT_MS[unit] : new Date(date).getTime();
  const valid = Number.isFinite(until) && until > now() && (mode === "date" || Number(amount) > 0);
  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <section className="thread-rail-snooze" role="dialog" aria-modal="true" aria-label="Snooze thread" onMouseDown={(event) => event.stopPropagation()}>
        <h2>Snooze “{session.title}”</h2>
        <div className="segmented" role="group" aria-label="Snooze by">
          <button type="button" className={mode === "duration" ? "active" : ""} aria-pressed={mode === "duration"} onClick={() => setMode("duration")}>For a while</button>
          <button type="button" className={mode === "date" ? "active" : ""} aria-pressed={mode === "date"} onClick={() => setMode("date")}>Until a date</button>
        </div>
        <form onSubmit={(event) => { event.preventDefault(); if (valid) onSnooze(until); }}>
          {mode === "duration" ? (
            <div className="thread-rail-snooze-row">
              <input aria-label="How long" type="number" min="1" value={amount} onChange={(event) => setAmount(event.target.value)} autoFocus />
              <select aria-label="Unit" value={unit} onChange={(event) => setUnit(event.target.value as Unit)}>
                <option value="minutes">minutes</option>
                <option value="hours">hours</option>
                <option value="days">days</option>
              </select>
            </div>
          ) : (
            <div className="thread-rail-snooze-row">
              <input aria-label="Wake at" type="datetime-local" value={date} onChange={(event) => setDate(event.target.value)} />
            </div>
          )}
          <footer>
            <button type="button" className="text-button" onClick={onClose}>Cancel</button>
            <button type="submit" className="primary" disabled={!valid}>Snooze</button>
          </footer>
        </form>
      </section>
    </div>
  );
}
