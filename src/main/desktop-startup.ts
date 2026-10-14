export interface DesktopStartup {
  showWindow(): Promise<void>;
  prepareHost(): Promise<void>;
  /** Installs local socket and certificate policy before the page connects. */
  prepareMachines(): void;
  connectWindow(): Promise<void>;
  restoreMachines(): Promise<void>;
  onRestoreError(error: unknown): void;
}

export async function startDesktop(startup: DesktopStartup): Promise<void> {
  await startup.showWindow();
  await startup.prepareHost();
  startup.prepareMachines();
  await startup.connectWindow();
  void startup.restoreMachines().catch(startup.onRestoreError);
}
