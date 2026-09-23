import type { SystemNotification, SystemNotificationOutcome } from "../shared/system-attention.js";

/** The part of Electron's `Notification` this module drives. */
export interface NativeNotification {
  on(event: "click" | "close" | "failed", listener: () => void): unknown;
  show(): void;
  close(): void;
}

export interface WindowAttentionPorts {
  /** `process.platform`; Windows draws the badge as the taskbar button's overlay. */
  platform?: string;
  isSupported(): boolean;
  create(notification: SystemNotification): NativeNotification;
  /** Brings the workbench window forward, restoring it when minimised; false when there is none. */
  reveal(): boolean;
  /** `app.setBadgeCount`: the dock on macOS, the launcher on Linux. */
  setBadgeCount(count: number): boolean;
  /** Windows has no badge count; the window's taskbar button takes an overlay icon instead. Used only there. */
  setOverlayBadge?(count: number): boolean;
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
      const set = ports.platform === "win32" && ports.setOverlayBadge ? ports.setOverlayBadge(count) : ports.setBadgeCount(count);
      ports.log?.("window-attention.badge", { count, set });
    },
  };
}

/** Side of the overlay icon Windows draws on the taskbar button, in pixels. */
export const OVERLAY_BADGE_SIZE = 16;

/**
 * A filled dot for `setOverlayIcon`, as raw BGRA: the overlay is too small for
 * a legible count, so it says "something is unseen" and the tooltip the count.
 */
export function overlayBadgeBitmap(size = OVERLAY_BADGE_SIZE): Buffer {
  const bitmap = Buffer.alloc(size * size * 4);
  const radius = size / 2;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const distance = Math.hypot(x + 0.5 - radius, y + 0.5 - radius);
      // One pixel of falloff at the rim, so the edge is not jagged.
      const alpha = Math.round(255 * Math.max(0, Math.min(1, radius - distance)));
      const offset = (y * size + x) * 4;
      // Premultiplied, as Windows composites it: #e5484d.
      bitmap[offset] = Math.round(0x4d * alpha / 255);
      bitmap[offset + 1] = Math.round(0x48 * alpha / 255);
      bitmap[offset + 2] = Math.round(0xe5 * alpha / 255);
      bitmap[offset + 3] = alpha;
    }
  }
  return bitmap;
}
