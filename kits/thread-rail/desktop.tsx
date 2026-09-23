import { useState, useSyncExternalStore } from "react";
import { AlarmClock, GitFork, ListTree, X } from "lucide-react";
import {
  HostUnavailableError,
  Menu,
  errorMessage,
  type ComposerControlProps,
  type DesktopExtension,
  type DesktopExtensionContext,
  type NewThreadClaimEvent,
  type PreferencesStore,
  type SettingsPageProps,
  type UiSession,
  type WorkbenchActions,
} from "tau";
import { sectionOf, wakeLabel } from "./meta.js";
import { createRailOrganizer } from "./organizer.js";
import {
  META_EVENT,
  SIBLINGS_SERVICE,
  THREAD_RAIL_EXTENSION_ID,
  WORKSPACE_STORE_SERVICE,
  type RailSettings,
  type RailState,
  type ThreadMetaPatch,
  type WorkspaceStoreSlice,
} from "./protocol.js";
import { FanOutSelection, RailStore, modelKey, parseModelKey } from "./store.js";

const noSubscription = () => () => undefined;

/** Snooze time and the place among siblings, beside the branch on a row. */
function createRailMark(store: RailStore) {
  return function RailMark({ session }: { session: UiSession }) {
    useSyncExternalStore(store.subscribe, store.getVersion);
    const meta = store.getState().threads[session.id];
    if (!meta) return null;
    const now = Date.now();
    const siblings = store.siblingsOf(session.id);
    const snoozed = sectionOf(meta, now) === "snoozed" && meta.snoozedUntil !== undefined;
    return (
      <>
        {snoozed ? (
          <span className="thread-rail-mark" title={`Snoozed until ${new Date(meta.snoozedUntil!).toLocaleString()}`}>
            <AlarmClock size={10} aria-hidden="true" />{wakeLabel(meta.snoozedUntil!, now)}
          </span>
        ) : null}
        {siblings.length > 1 ? (
          <span className="thread-rail-mark sibling" title={`One of ${siblings.length} threads started from the same prompt`}>
            <GitFork size={10} aria-hidden="true" />{siblings.indexOf(session.id) + 1}/{siblings.length}{meta.model ? ` · ${meta.model.split("/").slice(1).join("/")}` : ""}
          </span>
        ) : null}
      </>
    );
  };
}

/** The models a new thread's prompt will go to, while there is more than one. */
function createFanOutChip(selection: FanOutSelection, workspace: () => WorkspaceStoreSlice | undefined) {
  return function FanOutChip({ snapshot }: ComposerControlProps) {
    const keys = useSyncExternalStore(selection.subscribe, selection.selected);
    const store = workspace();
    const draftPending = useSyncExternalStore(store?.subscribe ?? noSubscription, () => store?.getSnapshot().draftPending ?? true);
    const [open, setOpen] = useState(false);
    if (keys.length < 2 || !draftPending) return null;
    const name = (key: string) => snapshot?.models.find((model) => modelKey(model) === key)?.name ?? key;
    return (
      <span className="menu-anchor">
        <button type="button" className="runtime-chip thread-rail-fanout" title="One thread and worktree per model" onClick={() => setOpen(true)}>
          <GitFork size={12} className="chip-icon" />{keys.length} models
        </button>
        {open ? (
          <Menu
            placement="above"
            sections={[
              { heading: "ONE THREAD EACH", items: keys.map((key, index) => ({ id: `remove:${index}`, label: name(key), hint: "remove" })) },
              { items: [...new Set(keys)].map((key) => ({ id: `again:${key}`, label: `Once more: ${name(key)}` })) },
              { items: [{ id: "clear", label: "Back to one model", icon: <X size={13} /> }] },
            ]}
            onSelect={(id) => {
              if (id === "clear") selection.reset();
              else if (id.startsWith("remove:")) selection.removeAt(Number(id.slice(7)));
              else if (id.startsWith("again:")) selection.add(id.slice(6));
            }}
            onClose={() => setOpen(false)}
          />
        ) : null}
      </span>
    );
  };
}

const INACTIVE_CHOICES: Array<{ days?: number; label: string }> = [
  { label: "Off" }, { days: 1, label: "1 day" }, { days: 3, label: "3 days" }, { days: 7, label: "7 days" }, { days: 30, label: "30 days" },
];

function createSettingsPage(store: RailStore, update: (settings: Partial<Record<keyof RailSettings, unknown>>) => Promise<void>) {
  return function ThreadRailSettings({ onNotify }: SettingsPageProps) {
    useSyncExternalStore(store.subscribe, store.getVersion);
    const settings = store.getState().settings;
    const change = (patch: Partial<Record<keyof RailSettings, unknown>>) => { update(patch).catch((error: unknown) => onNotify(errorMessage(error))); };
    const toggle = (key: "onMerged" | "onClosed", label: string, hint: string) => (
      <div className="settings-field-row">
        <span className="settings-field-label"><strong>{label}</strong><small>{hint}</small></span>
        <button type="button" role="switch" aria-checked={settings[key]} aria-label={label} className={`switch ${settings[key] ? "on" : ""}`} onClick={() => change({ [key]: !settings[key] })}><i /></button>
      </div>
    );
    return (
      <div className="settings-page thread-rail-settings">
        <h3>Thread rail</h3>
        <p className="lede">
          Settled threads leave the active list without being deleted. These rules settle a thread on their own, on the
          host, even while no window is open. A running thread, a snoozed one and one you just took off the shelf are left alone.
        </p>
        <div className="settings-label">SETTLE AUTOMATICALLY</div>
        <div className="settings-field-row">
          <span className="settings-field-label"><strong>After a quiet spell</strong><small>No turn for this long</small></span>
          <div className="segmented" role="group" aria-label="Settle after">
            {INACTIVE_CHOICES.map((choice) => (
              <button
                key={choice.label}
                type="button"
                className={settings.inactiveDays === choice.days ? "active" : ""}
                aria-pressed={settings.inactiveDays === choice.days}
                onClick={() => change({ inactiveDays: choice.days ?? null })}
              >{choice.label}</button>
            ))}
          </div>
        </div>
        {toggle("onMerged", "When its pull request merges", "Worktree threads only: their branch is theirs alone")}
        {toggle("onClosed", "When its pull request is closed", "Closed without merging")}
      </div>
    );
  };
}

/**
 * Core kept pins and the settled shelf in each client's preferences, and its
 * own surfaces (the title menu, Settle thread, a prompt into a settled
 * thread) still write there. This keeps the two in step: the host's meta is
 * the truth, mirrored into the preferences, and a change core makes there is
 * sent to the host.
 */
function bridgePreferences(preferences: PreferencesStore, store: RailStore, organizer: { togglePin(id: string): void; toggleSettledById(id: string): void }) {
  let mirrored: { pinned: Set<string>; settled: Set<string> } | undefined;
  let mirroring = false;
  const fromHost = () => {
    const threads = store.getState().threads;
    const pinned = new Set(Object.entries(threads).filter(([, meta]) => meta.pinned && meta.settledAt === undefined).map(([id]) => id));
    const settled = new Set(Object.entries(threads).filter(([, meta]) => meta.settledAt !== undefined).map(([id]) => id));
    const current = preferences.getSnapshot();
    mirroring = true;
    try {
      for (const id of new Set([...current.pinnedThreadIds, ...pinned])) if (current.pinnedThreadIds.includes(id) !== pinned.has(id)) preferences.togglePinned(id);
      for (const id of new Set([...current.settledThreadIds, ...settled])) if (current.settledThreadIds.includes(id) !== settled.has(id)) preferences.toggleSettled(id);
    } finally {
      mirroring = false;
    }
    mirrored = { pinned, settled };
  };
  const fromPreferences = () => {
    if (mirroring || !mirrored) return;
    const { pinnedThreadIds, settledThreadIds } = preferences.getSnapshot();
    const pinned = new Set(pinnedThreadIds);
    const settled = new Set(settledThreadIds);
    for (const id of new Set([...pinned, ...mirrored.pinned])) if (pinned.has(id) !== mirrored.pinned.has(id)) organizer.togglePin(id);
    for (const id of new Set([...settled, ...mirrored.settled])) if (settled.has(id) !== mirrored.settled.has(id)) organizer.toggleSettledById(id);
    mirrored = { pinned, settled };
  };
  const stops = [store.subscribe(() => { if (store.loaded) fromHost(); }), preferences.subscribe(fromPreferences)];
  return () => { for (const stop of stops) stop(); };
}

const firstLine = (text: string) => {
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
};

function randomId(): string {
  return Math.random().toString(16).slice(2, 10) + Date.now().toString(16);
}

/** mod+Enter in a new thread, and one prompt to several models: both start threads off screen. */
async function claimNewThread(
  event: NewThreadClaimEvent,
  actions: WorkbenchActions,
  context: DesktopExtensionContext,
  selection: FanOutSelection,
  workspace: WorkspaceStoreSlice | undefined,
): Promise<boolean> {
  const models = selection.selected();
  const fanOut = models.length > 1;
  if (!fanOut && !event.alternate) return false;
  if (event.runtime !== "pi") {
    actions.notify("Background and multi-model starts run on Pi; this one went out as a normal thread.");
    return false;
  }
  if (event.attachments > 0) {
    actions.notify("A thread started off screen takes text only; this one went out as a normal thread.");
    return false;
  }
  const start = (cwd: string, model?: { provider: string; id: string }, siblingGroupId?: string) =>
    context.host.invoke("start", { cwd, prompt: event.prompt, ...(model ? { model } : {}), ...(siblingGroupId ? { siblingGroupId } : {}) });
  if (!fanOut) {
    const prepared = await workspace?.prepareThreadWorktree({ prompt: event.prompt, preparing: event.preparing });
    await start(prepared?.workspace?.displayPath ?? event.projectPath, event.model);
    actions.notify(`Started in the background: ${firstLine(event.prompt)}`);
    return true;
  }
  if (!workspace?.getSnapshot().workspace?.isRepo) {
    actions.notify("One prompt to several models needs a Git project, one worktree per model; this one went out to a single model.");
    selection.reset();
    return false;
  }
  const group = randomId();
  let started = 0;
  for (const [index, key] of models.entries()) {
    const model = parseModelKey(key);
    // One after another: each worktree is a Git operation on the same repository.
    // oxlint-disable-next-line no-await-in-loop
    const prepared = await workspace.prepareThreadWorktree({ prompt: event.prompt, preparing: event.preparing, force: true, branchSuffix: String(index + 1) });
    if (!prepared.workspace) continue;
    try {
      // oxlint-disable-next-line no-await-in-loop
      await start(prepared.workspace.displayPath, model, group);
      started += 1;
    } catch (error) {
      actions.notify(`${key}: ${errorMessage(error)}`);
    }
  }
  selection.reset();
  actions.notify(started === models.length
    ? `Started ${started} threads from one prompt, one worktree each.`
    : `Started ${started} of ${models.length} threads; the rest could not get a worktree.`);
  return true;
}

/**
 * Thread Rail's desktop half: it organizes Workspace Kit's rail into pinned,
 * active, snoozed and settled threads, owns the row menu, the snooze dialog,
 * drag between sections and the thread commands, and starts threads off
 * screen (mod+Enter, several models at once) through its host half.
 */
export const threadRailExtension: DesktopExtension = {
  id: THREAD_RAIL_EXTENSION_ID,
  name: "Thread Rail",
  activate(context) {
    const store = new RailStore();
    const selection = new FanOutSelection();
    let workspace: WorkspaceStoreSlice | undefined;
    const send = (patches: Record<string, ThreadMetaPatch | null>) => {
      store.apply(patches);
      context.host.invoke("patch", { patches }).then((state) => store.set(state)).catch(() => {
        // The host pushes its own state again; a failed write shows as the row moving back.
        void context.host.invoke("state").then((state) => store.set(state)).catch(() => undefined);
      });
    };
    const organizer = createRailOrganizer(store, send);
    const load = (state: unknown, preferences: PreferencesStore) => {
      const { pinnedThreadIds, settledThreadIds } = preferences.getSnapshot();
      if (store.loaded || (pinnedThreadIds.length === 0 && settledThreadIds.length === 0)) { store.set(state); return; }
      // The host takes the old lists over only once, whichever client asks first.
      void context.host.invoke("import", { pinned: pinnedThreadIds, settled: settledThreadIds })
        .then((imported) => store.set(imported))
        .catch(() => store.set(state));
    };
    const stopMeta = context.host.onEvent(META_EVENT, (payload) => store.set(payload));
    void context.host.invoke("state").then((state) => load(state as RailState, context.preferences)).catch((error: unknown) => {
      if (!(error instanceof HostUnavailableError)) console.warn("Thread Rail could not read its state", error);
    });
    const stopBridge = bridgePreferences(context.preferences, store, organizer);

    const activeThread = (app: WorkbenchActions): string | undefined => {
      const active = app.activeThread();
      return active && !active.draftPending ? active.sessionId : undefined;
    };
    const withActive = (app: WorkbenchActions, run: (threadId: string) => void) => {
      const threadId = activeThread(app);
      if (threadId) run(threadId);
      else app.notify("Open a thread first.");
    };
    const go = (app: WorkbenchActions, direction: 1 | -1) => {
      const list = store.displayed;
      if (list.length === 0) return;
      const index = list.findIndex((thread) => thread.id === activeThread(app));
      const next = list[index < 0 ? (direction > 0 ? 0 : list.length - 1) : (index + direction + list.length) % list.length];
      if (next) void app.switchSession(next.path);
    };

    const disposers: Array<() => void> = [
      stopMeta,
      stopBridge,
      context.provideService(SIBLINGS_SERVICE, { siblingsOf: store.siblingsOf, subscribe: store.subscribe }),
      context.useService<WorkspaceStoreSlice>(WORKSPACE_STORE_SERVICE, (value) => {
        workspace = value;
        const stops = [value.registerThreadRailOrganizer(organizer), value.registerThreadRowAccessory(createRailMark(store))];
        return () => {
          for (const stop of stops) stop();
          if (workspace === value) workspace = undefined;
        };
      }),
      context.registerModelSelection(selection),
      context.registerComposerControl({ id: "thread-rail.fan-out", placement: "toolbar", order: 30, profiles: ["desktop"], Component: createFanOutChip(selection, () => workspace) }),
      context.registerPromptHook({
        id: "thread-rail.start",
        claimNewThread: (event, actions) => claimNewThread(event, actions, context, selection, workspace),
      }),
      context.registerSettingsPage({
        id: "thread-rail.settings",
        label: "Thread rail",
        Icon: ListTree,
        order: 40,
        profiles: ["desktop", "web"],
        Component: createSettingsPage(store, async (settings) => { store.set(await context.host.invoke("settings", settings)); }),
      }),
      context.registerCommand({ id: "thread.pin", label: "Pin or unpin thread", group: "Thread", run: (app) => withActive(app, organizer.togglePin) }),
      context.registerCommand({ id: "thread.settle", label: "Settle or un-settle thread", group: "Thread", run: (app) => withActive(app, organizer.toggleSettledById) }),
      context.registerCommand({
        id: "thread.snooze",
        label: "Snooze thread…",
        group: "Thread",
        surfaces: ["thread-title"],
        run: (app) => withActive(app, (threadId) => {
          const session = [...store.displayed].find((thread) => thread.id === threadId);
          if (session) store.openSnooze(session);
          else app.notify("This thread is not in the rail.");
        }),
      }),
      context.registerCommand({ id: "thread.next", label: "Next thread in the rail", group: "Thread", run: (app) => go(app, 1) }),
      context.registerCommand({ id: "thread.prev", label: "Previous thread in the rail", group: "Thread", run: (app) => go(app, -1) }),
      context.registerKeybinding({ keys: "mod+shift+p", commandId: "thread.pin" }),
      context.registerKeybinding({ keys: "mod+shift+s", commandId: "thread.settle", replaces: "workspace.settle" }),
      // T3 Code's chords, and the arrows Tau had before them.
      context.registerKeybinding({ keys: "mod+shift+]", commandId: "thread.next" }),
      context.registerKeybinding({ keys: "mod+shift+[", commandId: "thread.prev" }),
      context.registerKeybinding({ keys: "mod+alt+arrowdown", commandId: "thread.next" }),
      context.registerKeybinding({ keys: "mod+alt+arrowup", commandId: "thread.prev" }),
    ];
    // As in T3 Code; the open model picker answers the same digits with its own jumps.
    for (let position = 1; position <= 9; position += 1) {
      const id = `thread.jump-${position}`;
      disposers.push(
        context.registerCommand({
          id,
          label: `Open thread ${position} of the rail`,
          group: "Thread",
          run: (app) => { const thread = store.displayed[position - 1]; if (thread) void app.switchSession(thread.path); },
        }),
        context.registerKeybinding({ keys: `mod+${position}`, commandId: id, when: "!modelPickerOpen" }),
      );
    }
    return () => { for (const dispose of disposers.reverse()) dispose(); };
  },
};

export default threadRailExtension;
