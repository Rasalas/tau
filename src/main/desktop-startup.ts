export interface DesktopStartup {
  showWindow(): Promise<void>;
  prepareHost(): Promise<void>;
  connectWindow(): Promise<void>;
  restoreMachines(): Promise<void>;
  onRestoreError(error: unknown): void;
}

export async function startDesktop(startup: DesktopStartup): Promise<void> {
  await startup.showWindow();
  await startup.prepareHost();
  await startup.connectWindow();
  void startup.restoreMachines().catch(startup.onRestoreError);
}
