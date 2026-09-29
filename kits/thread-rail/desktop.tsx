import { useState, useSyncExternalStore } from "react";
import { AlarmClock, Archive, GitFork, ListTree, Trash2, X } from "lucide-react";
import {
  HostUnavailableError,
  Menu,
  Select,
  SettingRow,
  SettingsSection,
  Switch,
  errorMessage,
  hostIsReadOnly,
  READ_ONLY_REASON,
  useHostCapabilities,
  useSetting,
  type ComposerControlProps,
  type DesktopExtension,
  type DesktopExtensionContext,
  type NewThreadClaimEvent,
  type PreferencesStore,
  type RegionProps,
  type SettingsPageProps,
  type UiSession,
  type WorkbenchActions,
} from "tau";
import { sectionOf, wakeLabel } from "./meta.js";
import { createArchivedPage } from "./archived-page.js";
import { createRailOrganizer } from "./organizer.js";
import {
  META_EVENT,
  SIBLINGS_SERVICE,
  THREAD_RAIL_EXTENSION_ID,
  THREAD_TITLES_SERVICE,
  TRASH_EVENT,
  WORKSPACE_STORE_SERVICE,
  type TrashedThread,
  RAIL_CONFIRMATIONS,
  type RailQuestionAction,
  type RailSettings,
  type RailState,
  type ThreadMetaPatch,
  type ThreadTitlesSlice,
  type WorkspaceStoreSlice,
} from "./protocol.js";
import { FanOutSelection, RailStore, modelKey, parseModelKey } from "./store.js";
import { ThreadUndo, type UndoAction } from "./undo.js";

const UNDO_VERB: Record<UndoAction, string> = { Unpinned: "unpin", Settled: "settle", Snoozed: "snooze", Archived: "archive", Deleted: "delete" };

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
              { heading: "One thread each", items: keys.map((key, index) => ({ id: `remove:${index}`, label: name(key), hint: "remove" })) },
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

/** A quiet bar over a settled thread's composer, with the way back. */
function createSettledNote(store: RailStore, unsettle: (threadId: string) => void) {
  return function SettledNote({ snapshot, actions }: RegionProps) {
    useSyncExternalStore(store.subscribe, store.getVersion);
    const threadId = snapshot?.sessionId;
    if (!threadId || actions.activeThread()?.draftPending || store.getState().threads[threadId]?.settledAt === undefined) return null;
    return (
      <div className="thread-rail-settled-note" role="status">
        <span>This thread is settled</span>
        <button type="button" onClick={() => unsettle(threadId)}>Un-settle</button>
      </div>
    );
  };
}

const INACTIVE_DAYS = [1, 3, 7, 30];
const daysLabel = (days: number) => `${days} day${days === 1 ? "" : "s"}`;

/** Off and the usual spells, plus the host's own value when it holds another one. */
function inactiveChoices(current: number | undefined): Array<{ value: string; label: string }> {
  const days = current === undefined || INACTIVE_DAYS.includes(current) ? INACTIVE_DAYS : [...INACTIVE_DAYS, current].sort((a, b) => a - b);
  return [{ value: "off", label: "Off" }, ...days.map((entry) => ({ value: String(entry), label: daysLabel(entry) }))];
}

/** What the Settings search finds on the Thread rail page; each id is a row's anchor. */
export const THREAD_RAIL_ROWS = [
  { id: "setting-thread-rail-inactive", label: "After a quiet spell", keywords: ["settle", "inactive", "idle", "days", "auto settle"] },
  { id: "setting-thread-rail-onMerged", label: "When its pull request merges", keywords: ["settle", "merged", "pull request", "merge request", "worktree"] },
  { id: "setting-thread-rail-onClosed", label: "When its pull request is closed", keywords: ["settle", "closed", "pull request", "merge request"] },
  ...(Object.values(RAIL_CONFIRMATIONS).map(({ option, label }) => ({ id: `setting-thread-rail-${option}`, label, keywords: ["ask first", "confirm", "confirmation", "dialog"] }))),
];

const readBoolean = (raw: unknown) => (typeof raw === "boolean" ? raw : undefined);

/** One "ask first" switch: an option in Tau's config, so it shows its level like any row. */
function ConfirmationRow({ action, preferences }: { action: RailQuestionAction; preferences: PreferencesStore }) {
  const { option, fallback, label, hint } = RAIL_CONFIRMATIONS[action];
  const setting = useSetting<boolean>(`options.${THREAD_RAIL_EXTENSION_ID}.${option}`, { defaultValue: fallback, read: readBoolean, offline: (value) => preferences.setOption(THREAD_RAIL_EXTENSION_ID, option, value) });
  return (
    <SettingRow
      id={`setting-thread-rail-${option}`}
      title={label}
      description={`${hint}.`}
      setting={setting}
      control={<Switch label={label} checked={setting.value} onChange={setting.set} />}
    />
  );
}

function createSettingsPage(store: RailStore, preferences: PreferencesStore, update: (settings: Partial<Record<keyof RailSettings, unknown>>) => Promise<void>) {
  return function ThreadRailSettings({ onNotify }: SettingsPageProps) {
    useSyncExternalStore(store.subscribe, store.getVersion);
    useSyncExternalStore(preferences.subscribe, preferences.getSnapshot);
    const settings = store.getState().settings;
    const readOnly = useHostCapabilities().readOnly ? READ_ONLY_REASON : undefined;
    const change = (patch: Partial<Record<keyof RailSettings, unknown>>) => { update(patch).catch((error: unknown) => onNotify(errorMessage(error))); };
    // The rules live with the host's sweep (its own state file), not in Tau's config, so these rows have no levels.
    const toggle = (key: "onMerged" | "onClosed", label: string, hint: string) => (
      <SettingRow
        id={`setting-thread-rail-${key}`}
        title={label}
        description={hint}
        disabledReason={readOnly}
        control={<Switch label={label} checked={settings[key]} onChange={(next) => change({ [key]: next })} />}
      />
    );
    return (
      <div className="settings-page thread-rail-settings">
        <h3>Thread rail</h3>
        <SettingsSection title="Settle automatically">
          <SettingRow
            id="setting-thread-rail-inactive"
            title="After a quiet spell"
            description="Settle a thread that had no turn for this long."
            disabledReason={readOnly}
            control={<Select
              label="Settle after a quiet spell"
              width="sm"
              value={settings.inactiveDays === undefined ? "off" : String(settings.inactiveDays)}
              options={inactiveChoices(settings.inactiveDays)}
              onChange={(next) => change({ inactiveDays: next === "off" ? null : Number(next) })}
            />}
          />
          {toggle("onMerged", "When its pull request merges", "Worktree threads only: their branch is theirs alone.")}
          {toggle("onClosed", "When its pull request is closed", "Closed without merging.")}
        </SettingsSection>
        <SettingsSection title="Ask first">
          {(Object.keys(RAIL_CONFIRMATIONS) as RailQuestionAction[]).map((action) => <ConfirmationRow key={action} action={action} preferences={preferences} />)}
        </SettingsSection>
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
    let titles: ThreadTitlesSlice | undefined;
    const send = (patches: Record<string, ThreadMetaPatch | null>): Promise<boolean> => {
      // The host refuses a Read-only device's changes (ADR 0024); nothing moves, and it says why.
      if (hostIsReadOnly()) { store.actions?.notify(READ_ONLY_REASON); return Promise.resolve(false); }
      store.apply(patches);
      return context.host.invoke("patch", { patches }).then((state) => { store.set(state); return true; }, () => {
        // The host pushes its own state again; a failed write shows as the row moving back.
        void context.host.invoke("state").then((state) => store.set(state)).catch(() => undefined);
        return false;
      });
    };
    const undo = new ThreadUndo({ onError: (action, error) => store.actions?.notify(`Failed to undo ${UNDO_VERB[action]}: ${errorMessage(error)}`) });
    const trashListeners = new Set<(trash: readonly TrashedThread[]) => void>();
    const organizer = createRailOrganizer(store, {
      send,
      undo,
      archive: async (threadId) => { store.set(await context.host.invoke("archive", { threadId })); },
      remove: async (threadId) => { await context.host.invoke("remove", { threadId }); },
      restore: async (threadId) => { await context.host.invoke("restore", { threadId }); },
      running: (threadId) => store.running.has(threadId),
      workspace: () => workspace,
      titles: () => titles,
      confirm: (action, sessions) => {
        const { option, fallback } = RAIL_CONFIRMATIONS[action];
        if (!context.preferences.optionValue(THREAD_RAIL_EXTENSION_ID, option, fallback)) return Promise.resolve(true);
        return new Promise<boolean>((resolve) => store.ask({
          action,
          sessions,
          answer: (confirmed, dontAskAgain) => {
            if (confirmed && dontAskAgain) context.preferences.setOption(THREAD_RAIL_EXTENSION_ID, option, false);
            resolve(confirmed);
          },
        }));
      },
    });
    const load = (state: unknown, preferences: PreferencesStore) => {
      const { pinnedThreadIds, settledThreadIds } = preferences.getSnapshot();
      if (store.loaded || hostIsReadOnly() || (pinnedThreadIds.length === 0 && settledThreadIds.length === 0)) { store.set(state); return; }
      // The host takes the old lists over only once, whichever client asks first.
      void context.host.invoke("import", { pinned: pinnedThreadIds, settled: settledThreadIds })
        .then((imported) => store.set(imported))
        .catch(() => store.set(state));
    };
    const stopMeta = context.host.onEvent(META_EVENT, (payload) => store.set(payload));
    const stopTrash = context.host.onEvent(TRASH_EVENT, (payload) => {
      const list = Array.isArray(payload) ? payload as TrashedThread[] : [];
      for (const listener of trashListeners) listener(list);
    });
    const stopRunning = context.events.on("agent-status", (event) => {
      if (event.running) store.running.add(event.sessionId);
      else store.running.delete(event.sessionId);
    });
    void context.host.invoke("state").then((state) => load(state as RailState, context.preferences)).catch((error: unknown) => {
      if (!(error instanceof HostUnavailableError)) console.warn("Thread Rail could not read its state", error);
    });
    const stopBridge = bridgePreferences(context.preferences, store, organizer);

    const activeThread = (app: WorkbenchActions): string | undefined => {
      const active = app.activeThread();
      return active && !active.draftPending ? active.sessionId : undefined;
    };
    // A `thread-row` surface names its thread; the title menu and the palette mean the open one.
    const withActive = (app: WorkbenchActions, run: (threadId: string) => void, named?: string) => {
      const threadId = named ?? activeThread(app);
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

    /** The thread a title-menu command acts on. */
    const withActiveSession = (app: WorkbenchActions, run: (session: UiSession) => Promise<void>, named?: string) => withActive(app, (threadId) => {
      store.actions = app;
      const session = store.session(threadId);
      if (session) void run(session);
      else app.notify("This thread is not in the index yet.");
    }, named);

    const disposers: Array<() => void> = [
      stopMeta,
      stopTrash,
      stopRunning,
      () => undo.dispose(),
      () => store.dispose(),
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
      context.useService<ThreadTitlesSlice>(THREAD_TITLES_SERVICE, (value) => {
        titles = value;
        return () => { if (titles === value) titles = undefined; };
      }),
      context.registerModelSelection(selection),
      context.registerRegion({ id: "thread-rail.settled-note", placement: "composer-above", order: 90, profiles: ["desktop", "web"], Component: createSettledNote(store, organizer.toggleSettledById) }),
      // The rail's dialogs and undo offer; on the desktop the workspace sidebar mounts them, elsewhere this does.
      context.registerRegion({ id: "thread-rail.layer", placement: "composer-below", order: 99, profiles: ["web", "compact"], Component: ({ actions }: RegionProps) => (organizer.Layer ? <organizer.Layer actions={actions} /> : null) }),
      context.registerComposerControl({ id: "thread-rail.fan-out", placement: "toolbar", order: 30, profiles: ["desktop"], Component: createFanOutChip(selection, () => workspace) }),
      context.registerPromptHook({
        id: "thread-rail.start",
        claimNewThread: (event, actions) => claimNewThread(event, actions, context, selection, workspace),
      }),
      context.registerSettingsPage({
        id: "thread-rail.settings",
        label: "Thread rail",
        description: "Which threads the rail keeps in the active list, and when it settles one on its own. Settling never deletes a thread.",
        group: "threads",
        Icon: ListTree,
        order: 40,
        profiles: ["desktop", "web"],
        rows: THREAD_RAIL_ROWS,
        Component: createSettingsPage(store, context.preferences, async (settings) => { store.set(await context.host.invoke("settings", settings)); }),
      }),
      context.registerCommand({ id: "thread.pin", label: "Pin or unpin thread", group: "Thread", access: "write", run: (app) => withActive(app, organizer.togglePin) }),
      context.registerCommand({ id: "thread.settle", label: "Settle or un-settle thread", group: "Thread", access: "write", run: (app) => withActive(app, (threadId) => organizer.toggleSettledById(threadId, app)) }),
      context.registerCommand({
        id: "thread.snooze",
        label: "Snooze thread…",
        group: "Thread",
        access: "write",
        surfaces: ["thread-title", "thread-row"],
        Icon: AlarmClock,
        run: (app, target) => withActive(app, (threadId) => {
          const session = store.session(threadId);
          if (session) store.openSnooze(session);
          else app.notify("This thread is not in the rail.");
        }, target?.threadId),
      }),
      context.registerCommand({
        id: "thread.archive",
        label: "Archive thread",
        group: "Thread",
        access: "write",
        surfaces: ["thread-title", "thread-row"],
        Icon: Archive,
        run: (app, target) => withActiveSession(app, (session) => organizer.archive(session, app), target?.threadId),
      }),
      context.registerCommand({
        id: "thread.delete",
        label: "Delete thread",
        group: "Thread",
        access: "write",
        surfaces: ["thread-title", "thread-row"],
        destructive: true,
        Icon: Trash2,
        run: (app, target) => withActiveSession(app, (session) => organizer.remove(session, app), target?.threadId),
      }),
      context.registerCommand({
        id: "thread.undo",
        label: "Undo the last thread action",
        group: "Thread",
        access: "write",
        run: (app) => { store.actions ??= app; undo.undo(); },
      }),
      context.registerCommand({ id: "thread.archived", label: "Show archived threads", group: "Thread", access: "read", run: (app) => app.openSettings("thread-rail.archived") }),
      context.registerSettingsPage({
        id: "thread-rail.archived",
        label: "Archived",
        description: "Threads you archived or deleted: bring one back, or remove it for good.",
        group: "threads",
        Icon: Archive,
        order: 41,
        keywords: ["archive", "deleted", "trash", "restore", "unarchive"],
        profiles: ["desktop", "web"],
        Component: createArchivedPage(store, {
          unarchive: organizer.unarchive,
          remove: (session) => organizer.remove(session, store.actions),
          restore: organizer.restore,
          purge: async (threadId) => { await context.host.invoke("purge", { threadId }); },
          trash: async () => (await context.host.invoke("trash")) as TrashedThread[],
          subscribeTrash: (listener) => {
            trashListeners.add(listener);
            return () => { trashListeners.delete(listener); };
          },
        }),
      }),
      // Only outside a text field, where mod+z is the field's own undo.
      context.registerKeybinding({ keys: "mod+z", commandId: "thread.undo", when: "!terminalFocus && !editableFocus" }),
      context.registerCommand({ id: "thread.next", label: "Next thread in the rail", group: "Thread", access: "read", run: (app) => go(app, 1) }),
      context.registerCommand({ id: "thread.prev", label: "Previous thread in the rail", group: "Thread", access: "read", run: (app) => go(app, -1) }),
      context.registerKeybinding({ keys: "mod+shift+p", commandId: "thread.pin" }),
      context.registerKeybinding({ keys: "mod+shift+s", commandId: "thread.settle", replaces: "workspace.settle" }),
      // The common chords, and the arrows Tau had before them.
      context.registerKeybinding({ keys: "mod+shift+]", commandId: "thread.next" }),
      context.registerKeybinding({ keys: "mod+shift+[", commandId: "thread.prev" }),
      context.registerKeybinding({ keys: "mod+alt+arrowdown", commandId: "thread.next" }),
      context.registerKeybinding({ keys: "mod+alt+arrowup", commandId: "thread.prev" }),
    ];
    // The open model picker answers the same digits with its own jumps.
    for (let position = 1; position <= 9; position += 1) {
      const id = `thread.jump-${position}`;
      disposers.push(
        context.registerCommand({
          id,
          label: `Open thread ${position} of the rail`,
          group: "Thread",
          access: "read",
          run: (app) => { const thread = store.displayed[position - 1]; if (thread) void app.switchSession(thread.path); },
        }),
        context.registerKeybinding({ keys: `mod+${position}`, commandId: id, when: "!modelPickerOpen" }),
      );
    }
    return () => { for (const dispose of disposers.reverse()) dispose(); };
  },
};

export default threadRailExtension;
