import type { SystemNotification, SystemNotificationOutcome } from "../shared/system-attention.js";

/** The part of Electron's `Notification` this module drives. */
export interface NativeNotification {
  on(event: "click" | "close" | "failed", listener: () => void): unknown;
  show(): void;
  close(): void;
}

export interface WindowAttentionPorts {
  isSupported(): boolean;
  create(notification: SystemNotification): NativeNotification;
  /** Brings the workbench window forward, restoring it when minimised; false when there is none. */
  reveal(): boolean;
  /** `app.setBadgeCount`: the dock on macOS, the launcher on Linux. */
  setBadgeCount(count: number): boolean;
  /** What the OS was asked and what came of it, for the window's log. */
  log?(label: string, detail?: unknown): void;
}

/**
 * The window process's answer to `notify` and `set-badge`. The renderer has no
 * permission of its own to show a notification (ADR 0021 keeps it sandboxed),
 * so the process that owns the window draws it and reports the click back.
 */
export function createWindowAttention(ports: WindowAttentionPorts) {
  // Held until they end: Electron drops the click of a notification that was garbage collected.
  const live = new Map<string, { notification: NativeNotification; settle(outcome: SystemNotificationOutcome): void }>();
  let next = 0;
  return {
    notify(input: SystemNotification): Promise<SystemNotificationOutcome> {
      if (!ports.isSupported()) {
        ports.log?.("window-attention.notification", { tag: input.tag, outcome: "unavailable" });
        return Promise.resolve("unavailable");
      }
      const key = input.tag ?? `untagged-${next += 1}`;
      live.get(key)?.notification.close();
      return new Promise((resolve) => {
        const notification = ports.create({ title: input.title, ...(input.body ? { body: input.body } : {}) });
        let settled = false;
        const settle = (outcome: SystemNotificationOutcome) => {
          if (settled) return;
          settled = true;
          if (live.get(key)?.notification === notification) live.delete(key);
          ports.log?.("window-attention.notification", { tag: input.tag, outcome });
          resolve(outcome);
        };
        live.set(key, { notification, settle });
        notification.on("click", () => settle(ports.reveal() ? "clicked" : "dismissed"));
        notification.on("close", () => settle("dismissed"));
        notification.on("failed", () => settle("unavailable"));
        notification.show();
        ports.log?.("window-attention.notification", { tag: input.tag, outcome: "shown" });
      });
    },
    setBadge(count: number): void {
      const set = ports.setBadgeCount(count);
      ports.log?.("window-attention.badge", { count, set });
    },
  };
}
