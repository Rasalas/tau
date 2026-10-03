import type { UiProject, UiSession, UiThreadUsage } from "../shared/contracts.js";
import type { HostRuntimeBackendProvider } from "./host-extensions.js";
import { cleanThreadTitle, firstSentence, safeSessionTitle, visibleTitleText } from "./host-messages.js";
import { externalThreadPath } from "./pi-host-support.js";
import { hasThreadUsage } from "./session-usage.js";
import type { UsageTally } from "./usage-pricing.js";

export async function loadExternalSessionShells(options: {
  safeMode: boolean;
  providers: Iterable<HostRuntimeBackendProvider>;
  projectName(cwd: string): string;
  projectLabel(cwd: string): string | undefined;
  onProject?(threadId: string, project: Pick<UiProject, "name" | "icon"> & { listed?: boolean }): void;
  onError(provider: HostRuntimeBackendProvider, error: unknown): void;
  /** Prices a thread's tallies for its shell; without it a shell carries no cost. */
  usage?(path: string, tallies: readonly UsageTally[]): UiThreadUsage | undefined;
}): Promise<UiSession[]> {
  if (options.safeMode) return [];
  const shells: UiSession[] = [];
  for (const provider of options.providers) {
    let records: Awaited<ReturnType<HostRuntimeBackendProvider["listThreads"]>>;
    try { records = await provider.listThreads(); }
    catch (error) { options.onError(provider, error); continue; }
    for (const record of records) {
      if (record.project) options.onProject?.(record.threadId, record.project);
      const firstUser = record.messages.find((message) => message.role === "user");
      const modelProvider = record.model?.provider ?? provider.modelProvider;
      const path = externalThreadPath(provider.kind, record.threadId);
      const usage = record.usage?.length ? options.usage?.(path, record.usage) : undefined;
      shells.push({
        id: record.threadId,
        path,
        title: cleanThreadTitle(safeSessionTitle(record.title) || firstSentence(visibleTitleText(firstUser?.text ?? ""))),
        modifiedAt: record.updatedAt,
        projectPath: record.cwd,
        projectName: record.project?.name ?? options.projectName(record.cwd),
        ...(record.project?.listed === false ? { projectless: true } : {}),
        projectLabel: options.projectLabel(record.cwd),
        ...(record.workspace ? { workspaceId: record.workspace.workspaceId, projectDisplayPath: record.workspace.displayPath } : {}),
        messageCount: record.messageCount ?? record.messages.length,
        ...(record.machine ? { machine: { ...record.machine } } : {}),
        backendKind: provider.kind,
        ...(modelProvider ? { modelProvider } : {}),
        ...(record.model?.id ? { model: record.model.id } : {}),
        ...(hasThreadUsage(usage) ? { usage } : {}),
      });
    }
  }
  return shells;
}
