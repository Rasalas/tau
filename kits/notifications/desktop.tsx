import { useEffect, useSyncExternalStore } from "react";
import { Bell, Play } from "lucide-react";
import { Button, SegmentedControl, SettingRow, SettingsSection, Switch, useSetting, useThreadStore } from "tau";
import type {
  DesktopExtension,
  DesktopExtensionContext,
  PreferencesStore,
  RegionProps,
  SettingsPageProps,
  ThreadStore,
  ToastHandle,
  ToastType,
  WorkbenchActions,
} from "tau";
import {
  DEFAULT_SETTINGS,
  MODES,
  SOUNDS,
  badgeCount,
  describe,
  headline,
  presentation,
  readMode,
  readSound,
  type NotificationSettings,
} from "./present.js";
import {
  ATTENTION_EVENT,
  IDLE_AFTER_MS,
  NOTIFICATIONS_EXTENSION_ID as ID,
  NOTIFY_EVENT,
  PRESENCE_REQUEST_EVENT,
  QUIET,
  eventOption,
  decodeAttentionItems,
  decodeDelivery,
  type AttentionItem,
  type AttentionReason,
  type PresenceInput,
} from "./protocol.js";
import { playSound, unlockSound } from "./sounds.js";

const TOAST_MS = 8_000;

export function readSettings(preferences: PreferencesStore): NotificationSettings {
  return {
    mode: readMode(preferences.value(ID, "mode")),
    sound: readSound(preferences.value(ID, "sound")),
    toasts: preferences.optionValue(ID, "toasts", DEFAULT_SETTINGS.toasts),
    whenFocused: preferences.optionValue(ID, "when-focused", DEFAULT_SETTINGS.whenFocused),
  };
}

/**
 * The client's half: says which thread this window shows and whether it has
 * focus, keeps the app icon's badge at the count of unseen threads, and shows
 * what the host hands this client — a system notification, a sound, a toast.
 */
function coordinate(context: DesktopExtensionContext) {
  const clientKey = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const toasts = new Map<string, ToastHandle>();
  let threads: ThreadStore | undefined;
  let items: AttentionItem[] = [];
  let actions: WorkbenchActions | undefined;
  let eventThread: string | undefined;
  let badge: number | undefined;
  let reported = "";
  let lastUsed = Date.now();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  const settings = () => readSettings(context.preferences);
  const focused = () => document.visibilityState !== "hidden" && document.hasFocus();
  const idle = () => focused() && Date.now() - lastUsed >= IDLE_AFTER_MS;
  const onScreen = () => {
    const active = actions?.activeThread();
    if (active) return active.draftPending ? undefined : active.sessionId;
    return eventThread;
  };
  // The live index: a thread made after this window connected is in it, with the title the rail shows.
  const threadOf = (item: AttentionItem) => threads?.getSnapshot().threads.find((thread) => thread.id === item.threadId);
  const titleOf = (item: AttentionItem) => threadOf(item)?.title || item.title || "A thread";

  const applyBadge = () => {
    const next = badgeCount(settings(), items);
    if (next === badge) return;
    badge = next;
    context.attention?.setBadge(next);
  };
  const setItems = (next: AttentionItem[]) => { items = next; applyBadge(); };

  const open = (item: AttentionItem) => {
    const path = threadOf(item)?.path ?? item.path;
    if (path && actions) void actions.switchSession(path);
  };

  /** One toast per thread on core's stack; news of the same thread replaces it. */
  const toast = (item: AttentionItem) => {
    const id = `${ID}:${item.threadId}`;
    const handle = actions?.toast?.({
      id,
      type: TOAST_TYPES[item.reason],
      title: titleOf(item),
      description: headline(item.reason),
      timeoutMs: TOAST_MS,
      actions: [{ label: "Open", run: () => open(item) }],
      onClose: () => { if (toasts.get(id) === handle) toasts.delete(id); },
    });
    if (handle) toasts.set(id, handle);
  };

  const present = (delivered: AttentionItem[], seen = false) => {
    const [first] = delivered;
    if (!first) return;
    const current = settings();
    const plan = presentation(current, seen ? "on-screen" : focused() ? "other-thread" : "background");
    if (plan.sound) playSound(current.sound);
    if (plan.toast) for (const item of delivered.slice(0, 3).reverse()) toast(item);
    const attention = context.attention;
    if (!plan.system || !attention) return;
    const tag = delivered.length === 1 ? `tau.thread:${first.threadId}` : "tau.threads";
    void attention.notify({ ...describe(delivered, titleOf), tag }).then((outcome) => { if (outcome === "clicked") open(first); });
  };

  const report = (force = false) => {
    const threadId = onScreen();
    const presence: PresenceInput = { clientKey, focused: focused(), ...(threadId ? { threadId } : {}), ...(idle() ? { idle: true } : {}) };
    const key = `${presence.focused}:${threadId ?? ""}:${presence.idle === true}`;
    if (!force && key === reported) return;
    reported = key;
    context.host.invoke("presence", presence).then((reply) => {
      setItems(decodeAttentionItems(reply));
      const delivery = decodeDelivery((reply as { delivery?: unknown } | undefined)?.delivery);
      if (delivery) present(delivery.items);
    }).catch(() => { reported = ""; });
  };

  context.host.onEvent(ATTENTION_EVENT, (payload) => setItems(decodeAttentionItems(payload)));
  context.host.onEvent(NOTIFY_EVENT, (payload) => {
    const delivery = decodeDelivery(payload);
    if (delivery?.clientKey === clientKey) present(delivery.items, delivery.seen);
  });
  context.host.onEvent(PRESENCE_REQUEST_EVENT, () => report(true));
  // A client came or went, or this one reconnected to a host that may have restarted.
  context.events.on("client-count", () => report(true));
  context.events.on("active-thread-changed", (event) => { eventThread = event.sessionId; report(); });

  const changed = () => report();
  // A touch, a key or a click; a focused window nobody used for a while stops counting as attended.
  const used = () => {
    const wasIdle = idle();
    lastUsed = Date.now();
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => report(), IDLE_AFTER_MS);
    if (wasIdle) report();
  };
  const gesture = () => {
    used();
    if (settings().mode === "sound" || settings().mode === "both") unlockSound();
  };
  const onFocus = () => { used(); report(); };
  idleTimer = setTimeout(() => report(), IDLE_AFTER_MS);
  window.addEventListener("focus", onFocus);
  window.addEventListener("blur", changed);
  document.addEventListener("visibilitychange", changed);
  document.addEventListener("pointerdown", gesture, true);
  document.addEventListener("keydown", gesture, true);
  const stopPreferences = context.preferences.subscribe(applyBadge);
  report(true);

  return {
    bind(next: WorkbenchActions, store: ThreadStore) {
      actions = next;
      threads = store;
      report();
    },
    dispose() {
      clearTimeout(idleTimer);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", changed);
      document.removeEventListener("visibilitychange", changed);
      document.removeEventListener("pointerdown", gesture, true);
      document.removeEventListener("keydown", gesture, true);
      stopPreferences();
      for (const handle of [...toasts.values()]) handle.dismiss();
      if (badge) context.attention?.setBadge(0);
      void context.host.invoke("leave", { clientKey }).catch(() => undefined);
    },
  };
}

type Coordinator = ReturnType<typeof coordinate>;

/** A toast's icon is the rail's status mark: done, failed, or waiting for the user. */
const TOAST_TYPES: Record<AttentionReason, ToastType> = { completed: "success", failed: "error", question: "question", approval: "question" };

/** Draws nothing: core's toast stack shows the toasts, and a region is where a kit receives the actions. */
function createActionsRegion(coordinator: Coordinator) {
  return function NotificationActions({ actions }: RegionProps) {
    const threads = useThreadStore();
    useEffect(() => coordinator.bind(actions, threads), [actions, threads]);
    return null;
  };
}

const MODE_LABELS = Object.fromEntries(MODES.map((mode) => [mode.value, mode.label])) as Record<NotificationSettings["mode"], string>;
const SOUND_LABELS = Object.fromEntries(SOUNDS.map((sound) => [sound.value, sound.label])) as Record<NotificationSettings["sound"], string>;
const readBoolean = (raw: unknown) => (typeof raw === "boolean" ? raw : undefined);

function createSettingsPage(context: DesktopExtensionContext) {
  return function NotificationSettingsPage({ onNotify }: SettingsPageProps) {
    const preferences = context.preferences;
    useSyncExternalStore(preferences.subscribe, preferences.getSnapshot);
    const attention = context.attention;
    const mode = useSetting<NotificationSettings["mode"]>(`values.${ID}.mode`, {
      defaultValue: DEFAULT_SETTINGS.mode, read: (raw) => (typeof raw === "string" && raw in MODE_LABELS ? raw as NotificationSettings["mode"] : undefined),
      format: (value) => MODE_LABELS[value], offline: (value) => preferences.setValue(ID, "mode", value),
    });
    const sound = useSetting<NotificationSettings["sound"]>(`values.${ID}.sound`, {
      defaultValue: DEFAULT_SETTINGS.sound, read: (raw) => (typeof raw === "string" && raw in SOUND_LABELS ? raw as NotificationSettings["sound"] : undefined),
      format: (value) => SOUND_LABELS[value], offline: (value) => preferences.setValue(ID, "sound", value),
    });
    const toasts = useSetting<boolean>(`options.${ID}.toasts`, { defaultValue: DEFAULT_SETTINGS.toasts, read: readBoolean, offline: (value) => preferences.setOption(ID, "toasts", value) });
    const whenFocused = useSetting<boolean>(`options.${ID}.when-focused`, { defaultValue: DEFAULT_SETTINGS.whenFocused, read: readBoolean, offline: (value) => preferences.setOption(ID, "when-focused", value) });
    const choose = (next: NotificationSettings["mode"]) => {
      mode.set(next);
      if (next === "sound" || next === "both") unlockSound();
      if (next === "notification" || next === "both") void attention?.requestPermission?.();
    };
    const test = () => {
      if (!attention) { onNotify("This client cannot show system notifications."); return; }
      void attention.notify({ title: "Tau", body: "Notifications reach you like this.", tag: "tau.test" }).then((outcome) => {
        if (outcome === "unavailable") onNotify("The system would not show a notification. Check the notification settings for Tau.");
      });
    };
    return (
      <div className="settings-page notifications-settings">
        <h3>Notifications</h3>
        <SettingsSection title="When a thread needs you" headerAction={<Button variant="ghost" onClick={test}>Send a test notification</Button>}>
          <SettingRow
            id="setting-notifications-mode"
            title="Tell me with"
            description={attention ? "A system notification, a sound, both, or nothing." : "This client cannot show system notifications; sounds, toasts and nothing else."}
            setting={mode}
            control={<SegmentedControl label="Tell me with" value={mode.value} options={MODES} onChange={choose} />}
          />
          <SettingRow
            id="setting-notifications-sound"
            title="Sound"
            description="What plays when the mode includes a sound. Choosing one plays it."
            setting={sound}
            control={<>
              <SegmentedControl label="Sound" value={sound.value} options={SOUNDS} onChange={(next) => { sound.set(next); playSound(next); }} />
              <Button variant="ghost" icon={<Play size={13} />} aria-label={`Play ${SOUND_LABELS[sound.value]}`} onClick={() => playSound(sound.value)}>Play</Button>
            </>}
          />
        </SettingsSection>
        <NotifyWhen preferences={preferences} />
        <SettingsSection title="While Tau is in front">
          <SettingRow
            id="setting-notifications-toasts"
            title="Show a toast instead"
            description="When another thread is on screen, a toast in the window replaces the notification."
            setting={toasts}
            control={<Switch label="Show a toast instead" checked={toasts.value} onChange={toasts.set} />}
          />
          <SettingRow
            id="setting-notifications-when-focused"
            title="Also for the thread on screen"
            description="Notify and play the sound while you are looking at it."
            setting={whenFocused}
            control={<Switch label="Also for the thread on screen" checked={whenFocused.value} onChange={whenFocused.set} />}
          />
        </SettingsSection>
      </div>
    );
  };
}

/** The news a switch each silences (design 2n); the words are the phone Settings' summary. */
const EVENTS: ReadonlyArray<{ kind: AttentionReason; title: string; hint?: string; word: string }> = [
  { kind: "question", title: "A thread asks a question", hint: "the most useful one", word: "questions" },
  { kind: "approval", title: "A permission is needed", word: "permissions" },
  { kind: "completed", title: "A thread is done", word: "done" },
  { kind: "failed", title: "A thread failed", word: "failures" },
];

/** "Questions, done" beside Notifications on a phone's Settings list. */
function eventsSummary(preferences: PreferencesStore): string {
  const on = EVENTS.filter((event) => preferences.optionValue(ID, eventOption(event.kind), true)).map((event) => event.word);
  const text = on.length === EVENTS.length ? "all" : on.join(", ") || "off";
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function useOption(preferences: PreferencesStore, id: string, fallback: boolean) {
  return useSetting<boolean>(`options.${ID}.${id}`, { defaultValue: fallback, read: readBoolean, offline: (value) => preferences.setOption(ID, id, value) });
}

function useClock(preferences: PreferencesStore, id: string, fallback: string) {
  return useSetting<string>(`values.${ID}.${id}`, { defaultValue: fallback, read: (raw) => (typeof raw === "string" && /^\d\d:\d\d$/u.test(raw) ? raw : undefined), offline: (value) => preferences.setValue(ID, id, value) });
}

/** Which news reaches you at all, on any client and as a push, and when none does (design 2n, 2i). */
function NotifyWhen({ preferences }: { preferences: PreferencesStore }) {
  const settings = [
    useOption(preferences, eventOption("question"), true),
    useOption(preferences, eventOption("approval"), true),
    useOption(preferences, eventOption("completed"), true),
    useOption(preferences, eventOption("failed"), true),
  ];
  const events = EVENTS.map((event, index) => ({ ...event, setting: settings[index]! }));
  const quiet = useOption(preferences, QUIET.on, false);
  const from = useClock(preferences, QUIET.from, QUIET.start);
  const to = useClock(preferences, QUIET.to, QUIET.end);
  return <>
    <SettingsSection title="Notify me when">
      {events.map((event) => <SettingRow key={event.kind} id={`setting-notifications-${event.kind}`} title={event.title} description={event.hint} setting={event.setting}
        control={<Switch label={event.title} checked={event.setting.value} onChange={event.setting.set} />} />)}
    </SettingsSection>
    <SettingsSection title="Quiet hours">
      <SettingRow id="setting-notifications-quiet" title="Quiet hours" description={`${from.value} – ${to.value}, on the host's clock`} setting={quiet}
        control={<Switch label="Quiet hours" checked={quiet.value} onChange={quiet.set} />}>
        {quiet.value ? <div className="notifications-quiet">
          <input type="time" aria-label="Quiet from" value={from.value} onChange={(event) => { if (event.target.value) from.set(event.target.value); }} />
          <span aria-hidden="true">–</span>
          <input type="time" aria-label="Quiet until" value={to.value} onChange={(event) => { if (event.target.value) to.set(event.target.value); }} />
        </div> : null}
      </SettingRow>
    </SettingsSection>
  </>;
}

/** What the Settings search finds on the page; each id is a row's anchor. */
export const NOTIFICATION_ROWS = [
  { id: "setting-notifications-mode", label: "Tell me with", keywords: ["notification", "sound", "alert", "off", "system notification"] },
  { id: "setting-notifications-sound", label: "Sound", keywords: ["chime", "ping", "play", "audio"] },
  { id: "setting-notifications-toasts", label: "Show a toast instead", keywords: ["toast", "in-window", "banner"] },
  { id: "setting-notifications-when-focused", label: "Also for the thread on screen", keywords: ["focused", "on screen", "current thread"] },
  { id: "setting-notifications-question", label: "Notify me when", keywords: ["question", "permission", "done", "failed", "events"] },
  { id: "setting-notifications-quiet", label: "Quiet hours", keywords: ["night", "do not disturb", "mute"] },
];

const notifications: DesktopExtension = {
  id: ID,
  name: "Notifications",
  activate(context) {
    const coordinator = coordinate(context);
    context.registerRegion({ id: "notifications.toasts", placement: "composer-above", profiles: ["desktop", "web", "compact"], Component: createActionsRegion(coordinator) });
    const page = { id: "notifications.settings", label: "Notifications", Icon: Bell, group: "general", order: 45, rows: NOTIFICATION_ROWS } as const;
    context.registerSettingsPage({ ...page,
      description: "How Tau tells you that a thread finished, failed or asks you something while you look elsewhere. The window you used last hears of it.",
      profiles: ["desktop", "web"],
      Component: createSettingsPage(context),
    });
    // A phone hears through pushes: which news, and when not; the window's sound and toasts are not its own (design 2n).
    const preferences = context.preferences;
    context.registerSettingsPage({ ...page,
      profiles: ["compact"],
      useSummary: () => useSyncExternalStore(preferences.subscribe, () => eventsSummary(preferences)),
      Component: () => <div className="settings-page notifications-settings"><NotifyWhen preferences={preferences} /></div>,
    });
    return () => coordinator.dispose();
  },
};

export default notifications;
