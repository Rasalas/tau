import type { UiSession } from "../shared/contracts.js";
import type { HostRuntimeBackendProvider } from "./host-extensions.js";
import { cleanThreadTitle, firstSentence, safeSessionTitle, visibleTitleText } from "./host-messages.js";
import { externalThreadPath } from "./pi-host-support.js";

export async function loadExternalSessionShells(options: {
  safeMode: boolean;
  providers: Iterable<HostRuntimeBackendProvider>;
  projectName(cwd: string): string;
  projectLabel(cwd: string): string | undefined;
  onError(provider: HostRuntimeBackendProvider, error: unknown): void;
}): Promise<UiSession[]> {
  if (options.safeMode) return [];
  const shells: UiSession[] = [];
  for (const provider of options.providers) {
    let records: Awaited<ReturnType<HostRuntimeBackendProvider["listThreads"]>>;
    try { records = await provider.listThreads(); }
    catch (error) { options.onError(provider, error); continue; }
    for (const record of records) {
      const firstUser = record.messages.find((message) => message.role === "user");
      shells.push({
        id: record.threadId,
        path: externalThreadPath(provider.kind, record.threadId),
        title: cleanThreadTitle(safeSessionTitle(record.title) || firstSentence(visibleTitleText(firstUser?.text ?? ""))),
        modifiedAt: record.updatedAt,
        projectPath: record.cwd,
        projectName: options.projectName(record.cwd),
        projectLabel: options.projectLabel(record.cwd),
        messageCount: record.messages.length,
        backendKind: provider.kind,
        ...(provider.modelProvider ? { modelProvider: provider.modelProvider } : {}),
      });
    }
  }
  return shells;
}
