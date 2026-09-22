import { useEffect, useSyncExternalStore } from "react";
import { Bell, X } from "lucide-react";
import type {
  DesktopExtension,
  DesktopExtensionContext,
  PreferencesStore,
  RegionProps,
  SettingsPageProps,
  UiSession,
  WorkbenchActions,
} from "tau";
import {
  DEFAULT_SETTINGS,
  MODES,
  SOUNDS,
  badgeCount,
  describe,
  presentation,
  readMode,
  readSound,
  type NotificationSettings,
} from "./present.js";
import {
  ATTENTION_EVENT,
  NOTIFICATIONS_EXTENSION_ID as ID,
  NOTIFY_EVENT,
  PRESENCE_REQUEST_EVENT,
  decodeAttentionItems,
  decodeDelivery,
  type AttentionItem,
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

interface Toast { id: number; item: AttentionItem; title: string; body: string }

/** The in-window toasts, newest first, each gone after a few seconds. */
class Toasts {
  private items: Toast[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();
  private next = 0;

  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  get = () => this.items;

  show(toast: Omit<Toast, "id">): void {
    const id = this.next += 1;
    const replaced = this.items.filter((entry) => entry.item.threadId === toast.item.threadId);
    for (const entry of replaced) clearTimeout(this.timers.get(entry.id));
    this.items = [{ ...toast, id }, ...this.items.filter((entry) => !replaced.includes(entry))].slice(0, 3);
    this.timers.set(id, setTimeout(() => this.dismiss(id), TOAST_MS));
    this.changed();
  }

  dismiss(id: number): void {
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    this.items = this.items.filter((entry) => entry.id !== id);
    this.changed();
  }

  clear(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.items = [];
    this.changed();
  }

  private changed(): void { for (const listener of this.listeners) listener(); }
}

/**
 * The client's half: says which thread this window shows and whether it has
 * focus, keeps the app icon's badge at the count of unseen threads, and shows
 * what the host hands this client — a system notification, a sound, a toast.
 */
function coordinate(context: DesktopExtensionContext) {
  const clientKey = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const toasts = new Toasts();
  const threads = new Map<string, UiSession>();
  let items: AttentionItem[] = [];
  let actions: WorkbenchActions | undefined;
  let eventThread: string | undefined;
  let badge: number | undefined;
  let reported = "";

  const settings = () => readSettings(context.preferences);
  const focused = () => document.visibilityState !== "hidden" && document.hasFocus();
  const onScreen = () => {
    const active = actions?.activeThread();
    if (active) return active.draftPending ? undefined : active.sessionId;
    return eventThread;
  };
  const titleOf = (item: AttentionItem) => threads.get(item.threadId)?.title || item.title || "A thread";

  const applyBadge = () => {
    const next = badgeCount(settings(), items);
    if (next === badge) return;
    badge = next;
    context.attention?.setBadge(next);
  };
  const setItems = (next: AttentionItem[]) => { items = next; applyBadge(); };

  const open = (item: AttentionItem) => {
    const path = threads.get(item.threadId)?.path ?? item.path;
    if (path && actions) void actions.switchSession(path);
  };

  const present = (delivered: AttentionItem[], seen = false) => {
    const [first] = delivered;
    if (!first) return;
    const current = settings();
    const plan = presentation(current, seen ? "on-screen" : focused() ? "other-thread" : "background");
    if (plan.sound) playSound(current.sound);
    if (plan.toast) for (const item of delivered.slice(0, 3).reverse()) toasts.show({ item, ...describe([item], titleOf) });
    const attention = context.attention;
    if (!plan.system || !attention) return;
    const tag = delivered.length === 1 ? `tau.thread:${first.threadId}` : "tau.threads";
    void attention.notify({ ...describe(delivered, titleOf), tag }).then((outcome) => { if (outcome === "clicked") open(first); });
  };

  const report = (force = false) => {
    const threadId = onScreen();
    const presence: PresenceInput = { clientKey, focused: focused(), ...(threadId ? { threadId } : {}) };
    const key = `${presence.focused}:${threadId ?? ""}`;
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
  context.events.on("thread-index", (event) => {
    threads.clear();
    for (const session of event.threadIndex.sessions) threads.set(session.id, session);
  });

  const changed = () => report();
  const gesture = () => { if (settings().mode === "sound" || settings().mode === "both") unlockSound(); };
  window.addEventListener("focus", changed);
  window.addEventListener("blur", changed);
  document.addEventListener("visibilitychange", changed);
  document.addEventListener("pointerdown", gesture, true);
  document.addEventListener("keydown", gesture, true);
  const stopPreferences = context.preferences.subscribe(applyBadge);
  report(true);

  return {
    toasts,
    open,
    bind(next: WorkbenchActions) {
      actions = next;
      report();
    },
    dispose() {
      window.removeEventListener("focus", changed);
      window.removeEventListener("blur", changed);
      document.removeEventListener("visibilitychange", changed);
      document.removeEventListener("pointerdown", gesture, true);
      document.removeEventListener("keydown", gesture, true);
      stopPreferences();
      toasts.clear();
      if (badge) context.attention?.setBadge(0);
      void context.host.invoke("leave", { clientKey }).catch(() => undefined);
    },
  };
}

type Coordinator = ReturnType<typeof coordinate>;

function createToastRegion(coordinator: Coordinator) {
  return function NotificationToasts({ actions }: RegionProps) {
    useEffect(() => coordinator.bind(actions), [actions]);
    const toasts = useSyncExternalStore(coordinator.toasts.subscribe, coordinator.toasts.get);
    if (toasts.length === 0) return null;
    return (
      <div className="notifications-toasts" role="status">
        {toasts.map((toast) => (
          <div className="notifications-toast" key={toast.id} data-reason={toast.item.reason}>
            <Bell size={13} aria-hidden="true" />
            <span className="notifications-toast-text"><strong>{toast.title}</strong><small>{toast.body}</small></span>
            <button type="button" className="text-button" onClick={() => { coordinator.open(toast.item); coordinator.toasts.dismiss(toast.id); }}>Open</button>
            <button type="button" className="icon-button" aria-label="Dismiss" onClick={() => coordinator.toasts.dismiss(toast.id)}><X size={12} /></button>
          </div>
        ))}
      </div>
    );
  };
}

function createSettingsPage(context: DesktopExtensionContext) {
  return function NotificationSettingsPage({ onNotify }: SettingsPageProps) {
    const preferences = context.preferences;
    useSyncExternalStore(preferences.subscribe, preferences.getSnapshot);
    const settings = readSettings(preferences);
    const attention = context.attention;
    const toggle = (option: "toasts" | "when-focused", on: boolean, label: string, hint: string) => (
      <div className="settings-field-row">
        <span className="settings-field-label"><strong>{label}</strong><small>{hint}</small></span>
        <button type="button" role="switch" aria-checked={on} aria-label={label} className={`switch ${on ? "on" : ""}`} onClick={() => preferences.setOption(ID, option, !on)}><i /></button>
      </div>
    );
    const choose = (mode: NotificationSettings["mode"]) => {
      preferences.setValue(ID, "mode", mode);
      if (mode === "sound" || mode === "both") unlockSound();
      if (mode === "notification" || mode === "both") void attention?.requestPermission?.();
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
        <p className="lede">
          When a thread finishes, fails or asks you something and you are not looking at it. One window hears of it — the
          one you used last — and the app icon counts the threads you have not opened since. These choices belong to this window.
        </p>
        <div className="settings-label">WHEN A THREAD NEEDS YOU</div>
        <div className="segmented" role="group" aria-label="When a thread needs you">
          {MODES.map((mode) => (
            <button key={mode.value} type="button" className={settings.mode === mode.value ? "active" : ""} aria-pressed={settings.mode === mode.value} onClick={() => choose(mode.value)}>{mode.label}</button>
          ))}
        </div>
        <div className="settings-label">SOUND</div>
        <div className="notifications-sound-row">
          <div className="segmented" role="group" aria-label="Sound">
            {SOUNDS.map((sound) => (
              <button key={sound.value} type="button" className={settings.sound === sound.value ? "active" : ""} aria-pressed={settings.sound === sound.value} onClick={() => { preferences.setValue(ID, "sound", sound.value); playSound(sound.value); }}>{sound.label}</button>
            ))}
          </div>
          <button type="button" className="text-button" onClick={() => playSound(settings.sound)}>Play</button>
        </div>
        <div className="settings-label">WHILE TAU IS IN FRONT</div>
        {toggle("toasts", settings.toasts, "Show a toast instead", "When another thread is on screen, a toast in the window replaces the notification")}
        {toggle("when-focused", settings.whenFocused, "Also for the thread on screen", "Notify and play the sound while you are looking at it")}
        <div className="notifications-actions">
          <button type="button" className="text-button" onClick={test}>Send a test notification</button>
        </div>
        {attention ? null : <p className="settings-note">This client cannot show system notifications; sounds, toasts and nothing else.</p>}
      </div>
    );
  };
}

const notifications: DesktopExtension = {
  id: ID,
  name: "Notifications",
  activate(context) {
    const coordinator = coordinate(context);
    context.registerRegion({ id: "notifications.toasts", placement: "composer-above", profiles: ["desktop", "web", "compact"], Component: createToastRegion(coordinator) });
    context.registerSettingsPage({ id: "notifications.settings", label: "Notifications", Icon: Bell, order: 45, profiles: ["desktop", "web", "compact"], Component: createSettingsPage(context) });
    return () => coordinator.dispose();
  },
};

export default notifications;
