import type { ClientStorage } from "./client-storage";
import type { SystemNotification, SystemNotificationOutcome } from "../shared/system-attention";
import type { UiSharedFile } from "../shared/contracts";
import type { MenuPoint, NativeMenuEntry } from "../shared/context-menu";

export type { SystemNotification, SystemNotificationOutcome };

/**
 * Getting the user's attention from outside the page: a notification the OS
 * draws, and a count on the app's icon (the dock, the taskbar, a tab's icon).
 */
export interface PlatformAttention {
  /**
   * Shows a notification; resolves `clicked` once the user clicked it and the
   * client's window is in front, `dismissed` when it went away unclicked, and
   * `unavailable` when this machine or the user's permission would not show it.
   */
  notify(notification: SystemNotification): Promise<SystemNotificationOutcome>;
  /** The count on the app's icon; 0 clears it. */
  setBadge(count: number): void;
  /** Asks for the permission to notify, where the client needs one; call it from a click. */
  requestPermission?(): Promise<boolean>;
}

/**
 * What the workbench needs from the machine it runs on, and nothing else.
 * Electron supplies one implementation (`src/renderer/platform-electron.ts`);
 * a browser or mobile client supplies its own. Every capability here is one a
 * client may lack: `files` is absent when the host's paths are not this
 * machine's, and `importModule` is how a client evaluates an extension bundle
 * under whatever policy its page has.
 */
export interface Platform {
  /** The user's clipboard, not the host's: on a remote host these are different machines. */
  clipboard: {
    writeText(text: string): Promise<void>;
    /** Absent where the client cannot put an image on the clipboard. */
    writeImage?(dataUrl: string): Promise<void>;
  };
  /** Opens a URL outside the workbench; the workbench itself never navigates. */
  openExternal(url: string): void;
  /** Present only where the host's files are this machine's files. */
  files?: {
    openInEditor(path: string): void;
    /** A URL the page may load a workspace PDF, image, audio or video from; absent where nothing serves one. */
    shareFile?(path: string): Promise<UiSharedFile>;
  };
  storage: ClientStorage;
  /** Evaluates a module URL. A page with a strict CSP decides here what it will run. */
  importModule(url: string): Promise<unknown>;
  /** Absent where the client can reach the user only inside its own page. */
  attention?: PlatformAttention;
  /**
   * A right-click menu the OS draws at a point of the page, answering the
   * chosen id or undefined. Absent — or refusing — where the client has none;
   * the page then draws its own.
   */
  contextMenu?: {
    show(entries: NativeMenuEntry[], point: MenuPoint): Promise<string | undefined>;
  };
}
