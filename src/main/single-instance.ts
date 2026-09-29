import { join } from "node:path";

export interface AppIdentity {
  getPath(name: "appData"): string;
  setPath(name: "userData", path: string): void;
  setName(name: string): void;
  setAppUserModelId?(id: string): void;
}

/** `appId` in tooling/electron-builder.yml: the macOS bundle id and the AppUserModelID the installer's shortcuts carry. */
export const APP_ID = "de.tbuck.tau";

/**
 * Changes Tau's visible name without abandoning preferences stored under its
 * original package name. A separate `userData` gives a second, independent
 * instance (its own lock, window state and preferences) for verification runs.
 * Windows shows a toast only for an app whose AppUserModelID matches a shortcut's.
 */
export function configureAppIdentity(app: AppIdentity, userData?: string, platform: NodeJS.Platform = process.platform): void {
  app.setPath("userData", userData || join(app.getPath("appData"), "tau-pi-desktop-prototype"));
  app.setName("Tau");
  if (platform === "win32") app.setAppUserModelId?.(APP_ID);
}

export interface SingleInstanceApp {
  requestSingleInstanceLock(): boolean;
  quit(): void;
  on(event: "second-instance", listener: () => void): unknown;
}

export interface SingleInstanceWindow {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
}

/**
 * Keeps one desktop app alive and brings its window forward on later starts.
 * Starting Tau again while it has no window opens one: the host kept running
 * without it, so the window is the only thing missing (ADR 0021).
 */
export function installSingleInstance(
  app: SingleInstanceApp,
  currentWindow: () => SingleInstanceWindow | undefined,
  openWindow?: () => void,
): boolean {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return false;
  }
  app.on("second-instance", () => {
    const window = currentWindow();
    if (!window || window.isDestroyed()) {
      openWindow?.();
      return;
    }
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });
  return true;
}
