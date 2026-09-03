import { join } from "node:path";

export interface AppIdentity {
  getPath(name: "appData"): string;
  setPath(name: "userData", path: string): void;
  setName(name: string): void;
}

/** Changes Tau's visible name without abandoning preferences stored under its original package name. */
export function configureAppIdentity(app: AppIdentity): void {
  app.setPath("userData", join(app.getPath("appData"), "tau-pi-desktop-prototype"));
  app.setName("Tau");
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

/** Keeps one desktop host alive and brings its window forward on later starts. */
export function installSingleInstance(
  app: SingleInstanceApp,
  currentWindow: () => SingleInstanceWindow | undefined,
): boolean {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return false;
  }
  app.on("second-instance", () => {
    const window = currentWindow();
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });
  return true;
}
