import type {
  DesktopExtensionLoadResult,
  HostBootstrap,
  ExtensionInspection,
  ExtensionUiPrompt,
  HostExtensionSummary,
  ThreadTreeNavigationResult,
  UiImagePreview,
  UiSharedFile,
  UiThreadTree,
  UiToolOutputPreview,
  UiToolOutputReadResult,
  WorkbenchBuildResult,
  WorkbenchReloadPreparation,
  TauConfig,
  CustomProviderConfig,
  UiModel,
  UiRuntimeCatalog,
  UiRuntimeToolsState,
  SystemPromptInspection,
  UserTheme,
  ExternalEditorResult,
} from "./contracts.js";
import type { HostActionResult, ForkThreadResult, TranscriptPage } from "./host-protocol.js";
import type { ConfigLayers } from "./config-layers.js";

import type { SystemNotificationOutcome } from "./system-attention.js";

import { command } from "./host-command-definition.js";
import {
  decodeString,
  decodeSharedExports,
  decodeOptionalExtensionIds,
  decodeBundleHashes,
  decodeHostTranscriptCursor,
  decodeOptionalString,
  decodeOptionalBoolean,
  decodeNavigateOptions,
  decodeExtensionUiAnswer,
  decodeBoolean,
  decodeExtensionId,
  decodeWorkbenchReloadMode,
  decodeConfigPatch,
  decodeSettingKeys,
  decodeKnownCatalogs,
  decodeCustomProviderInput,
  decodeOptionalText,
  decodeCommandName,
} from "./host-command-input.js";
import { decodeNativeMenu, decodeMenuPoint } from "./context-menu.js";
import { decodeSystemNotification, decodeBadgeCount } from "./system-attention.js";
import { decodeWindowAction } from "./window-shell.js";

function runtimeToolsAction<const Actions extends readonly string[]>(channel: string, value: unknown, allowed: Actions): Actions[number] {
  const action = decodeString(channel, "action", value);
  if (!allowed.includes(action)) throw new Error(`${channel}: action must be one of ${allowed.join(", ")}.`);
  return action as Actions[number];
}
function runtimeToolsInput(value: unknown): { on?: boolean; kind?: string } {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("runtime-tools-change: input must be an object.");
  const { on, kind } = value as { on?: unknown; kind?: unknown };
  return {
    ...(on === undefined ? {} : { on: decodeBoolean("runtime-tools-change", "on", on) }),
    ...(kind === undefined ? {} : { kind: decodeString("runtime-tools-change", "kind", kind) }),
  };
}

/** Non-turn protocol commands, decoded before their host implementation runs. */
export const HOST_CORE_COMMANDS = {
  "copy-text": command<void>()({
    decode: (params) => [decodeString("copy-text", "text", params[0])] as const,
    access: "write",
    audit: { label: "copied text on the host" },
  }),
  "copy-image": command<void>()({
    decode: (params) => [decodeString("copy-image", "dataUrl", params[0])] as const,
    access: "write",
    audit: { label: "copied an image on the host" },
  }),
  "read-image-preview": command<UiImagePreview | undefined>()({
    decode: (params) => [decodeString("read-image-preview", "path", params[0])] as const,
    access: "read",
  }),
  "share-file": command<UiSharedFile>()({
    decode: (params) => [decodeString("share-file", "path", params[0])] as const,
    access: "read",
  }),
  "desktop-extensions": command<DesktopExtensionLoadResult, [cwd: string, sharedExports: Record<string, string[]>, only?: readonly string[], held?: readonly string[]]>()({
    decode: (params) => [decodeString("desktop-extensions", "cwd", params[0]), decodeSharedExports("desktop-extensions", "sharedExports", params[1]), decodeOptionalExtensionIds("desktop-extensions", "only", params[2]), decodeBundleHashes("desktop-extensions", "held", params[3])] as const,
    access: "read",
  }),
  "rebuild-workbench": command<WorkbenchBuildResult>()({
    decode: () => [] as const,
    access: "write",
    job: true,
    audit: { label: "rebuilt the workbench" },
  }),
  "workbench-source": command<{ path?: string }>()({
    decode: () => [] as const,
    access: "read",
  }),
  "relaunch-workbench": command<void>()({
    decode: () => [] as const,
    access: "write",
    audit: { label: "relaunched the workbench" },
  }),
  "install-update": command<{ installing: boolean }>()({
    decode: () => [] as const,
    access: "write",
    audit: { label: "installed an update" },
  }),
  "notify": command<SystemNotificationOutcome>()({
    decode: (params) => [decodeSystemNotification("notify", params[0])] as const,
    access: "write",
    audit: { label: "showed a notification on the host" },
  }),
  "set-badge": command<void>()({
    decode: (params) => [decodeBadgeCount("set-badge", params[0])] as const,
    access: "write",
    audit: { label: "set the app badge" },
  }),
  "context-menu": command<{ id?: string }>()({
    decode: (params) => [decodeNativeMenu("context-menu", params[0]), decodeMenuPoint("context-menu", params[1])] as const,
    access: "write",
    audit: { label: "opened a menu on the host" },
  }),
  "window-action": command<unknown>()({
    decode: (params) => [decodeWindowAction("window-action", params[0])] as const,
    access: "write",
    audit: { label: "used the host's window" },
  }),
  "bootstrap": command<HostBootstrap>()({
    decode: () => [] as const,
    access: "read",
  }),
  "transcript-page": command<TranscriptPage>()({
    decode: (params) => [decodeString("transcript-page", "sessionId", params[0]), decodeHostTranscriptCursor("transcript-page", "cursor", params[1])] as const,
    access: "read",
  }),
  "fork-thread": command<ForkThreadResult>()({
    decode: (params) => [decodeString("fork-thread", "entryId", params[0]), decodeOptionalString("fork-thread", "expectedSessionId", params[1]), decodeOptionalString("fork-thread", "cwd", params[2]), decodeOptionalBoolean("fork-thread", "background", params[3])] as const,
    access: "write",
    audit: { label: "forked a thread", thread: 1 },
  }),
  "thread-tree": command<UiThreadTree>()({
    decode: (params) => [decodeOptionalString("thread-tree", "sessionId", params[0])] as const,
    access: "read",
  }),
  "navigate-thread-tree": command<ThreadTreeNavigationResult>()({
    decode: (params) => [decodeString("navigate-thread-tree", "entryId", params[0]), decodeNavigateOptions("navigate-thread-tree", "options", params[1]), decodeOptionalString("navigate-thread-tree", "expectedSessionId", params[2])] as const,
    access: "write",
    audit: { label: "moved within a thread's tree", thread: 2 },
  }),
  "duplicate-thread": command<HostActionResult>()({
    decode: (params) => [decodeOptionalString("duplicate-thread", "expectedSessionId", params[0])] as const,
    access: "write",
    audit: { label: "duplicated a thread", thread: 0 },
  }),
  "switch-session": command<HostActionResult>()({
    decode: (params) => [decodeString("switch-session", "path", params[0])] as const,
    access: "read",
  }),
  "set-model": command<HostActionResult>()({
    decode: (params) => [decodeString("set-model", "provider", params[0]), decodeString("set-model", "id", params[1]), decodeOptionalString("set-model", "expectedSessionId", params[2])] as const,
    access: "write",
    audit: { label: "changed the model" },
  }),
  "set-thinking": command<HostActionResult>()({
    decode: (params) => [decodeString("set-thinking", "level", params[0]), decodeOptionalString("set-thinking", "expectedSessionId", params[1])] as const,
    access: "write",
    audit: { label: "changed the thinking level" },
  }),
  "set-mode": command<HostActionResult>()({
    decode: (params) => [decodeString("set-mode", "mode", params[0]), decodeOptionalString("set-mode", "expectedSessionId", params[1])] as const,
    access: "write",
    audit: { label: "changed the mode", thread: 1 },
  }),
  "compact-context": command<HostActionResult>()({
    decode: (params) => [decodeOptionalString("compact-context", "expectedSessionId", params[0])] as const,
    access: "write",
    audit: { label: "compacted the context" },
  }),
  "restart-session": command<HostActionResult>()({
    decode: (params) => [decodeString("restart-session", "threadId", params[0])] as const,
    access: "write",
    audit: { label: "restarted an agent session" },
  }),
  "reload-runtime": command<void>()({
    decode: () => [] as const,
    access: "write",
    audit: { label: "reloaded the runtime" },
  }),
  "reload-extensions": command<void>()({
    decode: () => [] as const,
    access: "write",
    audit: { label: "reloaded extensions" },
  }),
  "answer-extension-ui": command<void>()({
    decode: (params) => [decodeString("answer-extension-ui", "id", params[0]), decodeExtensionUiAnswer("answer-extension-ui", "answer", params[1])] as const,
    access: "write",
    audit: { label: "answered a question" },
  }),
  "sync-extension-ui": command<readonly ExtensionUiPrompt[] | undefined>()({
    decode: () => [] as const,
    access: "read",
  }),
  "recover-thread": command<HostActionResult>()({
    decode: () => [] as const,
    access: "write",
    audit: { label: "recovered a thread" },
  }),
  "rename-thread": command<HostActionResult>()({
    decode: (params) => [decodeString("rename-thread", "title", params[0]), decodeOptionalString("rename-thread", "expectedSessionId", params[1])] as const,
    access: "write",
    audit: { label: "renamed a thread", thread: 1 },
  }),
  "read-tool-output": command<UiToolOutputReadResult | undefined>()({
    decode: (params) => [decodeString("read-tool-output", "sessionId", params[0]), decodeString("read-tool-output", "toolCallId", params[1])] as const,
    access: "read",
  }),
  "tool-output": command<UiToolOutputPreview | undefined>()({
    decode: (params) => [decodeString("tool-output", "sessionId", params[0]), decodeString("tool-output", "toolCallId", params[1])] as const,
    access: "read",
  }),
  "copy-thread-markdown": command<string | undefined>()({
    decode: (params) => [decodeOptionalString("copy-thread-markdown", "expectedSessionId", params[0])] as const,
    access: "read",
  }),
  "host-extensions": command<HostExtensionSummary[]>()({
    decode: () => [] as const,
    access: "read",
  }),
  "inspect-extensions": command<ExtensionInspection>()({
    decode: (params) => [decodeString("inspect-extensions", "cwd", params[0])] as const,
    access: "read",
  }),
  "host-extension-active": command<HostExtensionSummary[]>()({
    decode: (params) => [decodeString("host-extension-active", "id", params[0]), decodeBoolean("host-extension-active", "active", params[1])] as const,
    access: "write",
    audit: { label: "turned an extension on or off" },
  }),
  "extension-grant": command<void>()({
    decode: (params) => [decodeExtensionId("extension-grant", params[0]), decodeBoolean("extension-grant", "grant", params[1])] as const,
    access: "write",
    audit: { label: "changed an extension's grant" },
  }),
  "prepare-workbench-reload": command<WorkbenchReloadPreparation>()({
    decode: (params) => [decodeWorkbenchReloadMode("prepare-workbench-reload", "mode", params[0])] as const,
    access: "write",
    audit: { label: "reloaded the workbench" },
  }),
  "release-workbench-reload": command<void>()({
    decode: () => [] as const,
    access: "write",
    audit: { label: "finished reloading the workbench", automatic: true },
  }),
  "open-project": command<HostActionResult>()({
    decode: (params) => [decodeString("open-project", "workspace", params[0])] as const,
    access: "write",
    audit: { label: "opened a project" },
  }),
  "remove-project": command<HostActionResult>()({
    decode: (params) => [decodeString("remove-project", "workspace", params[0])] as const,
    access: "write",
    audit: { label: "removed a project" },
  }),
  "get-config": command<TauConfig>()({
    decode: (params) => [decodeOptionalString("get-config", "workspace", params[0])] as const,
    access: "read",
  }),
  "update-config": command<TauConfig, [patch: Partial<TauConfig>, scope?: "global" | "project", workspaceId?: string]>()({
    decode: (params) => [decodeConfigPatch("update-config", "patch", params[0]), params[1] === "project" ? "project" as const : "global" as const, decodeOptionalString("update-config", "workspace", params[2])] as const,
    access: "write",
    audit: { label: "changed settings" },
  }),
  "get-config-layers": command<ConfigLayers>()({
    decode: (params) => [decodeOptionalString("get-config-layers", "workspace", params[0])] as const,
    access: "read",
  }),
  "clear-config": command<ConfigLayers, [keys: readonly string[], scope?: "global" | "project", workspaceId?: string]>()({
    decode: (params) => [decodeSettingKeys("clear-config", "keys", params[0]), params[1] === "project" ? "project" as const : "global" as const, decodeOptionalString("clear-config", "workspace", params[2])] as const,
    access: "write",
    audit: { label: "reset settings" },
  }),
  "get-models-config": command<CustomProviderConfig[]>()({
    decode: () => [] as const,
    access: "read",
  }),
  "runtime-catalog": command<UiRuntimeCatalog | undefined>()({
    decode: (params) => [decodeString("runtime-catalog", "kind", params[0])] as const,
    access: "read",
  }),
  "runtime-catalogs": command<UiRuntimeCatalog[], [revalidate?: boolean, known?: Record<string, number>]>()({
    decode: (params) => [decodeOptionalBoolean("runtime-catalogs", "revalidate", params[0]), decodeKnownCatalogs("runtime-catalogs", "known", params[1])] as const,
    access: "read",
  }),
  "runtime-tools": command<UiRuntimeToolsState>()({
    decode: (params) => [runtimeToolsAction("runtime-tools", params[0], ["state", "refresh"] as const)] as const,
    access: "read",
  }),
  "runtime-tools-change": command<UiRuntimeToolsState, [action: "automatic" | "update" | "switch", input: { on?: boolean; kind?: string }]>()({
    decode: (params) => [runtimeToolsAction("runtime-tools-change", params[0], ["automatic", "update", "switch"] as const), runtimeToolsInput(params[1])] as const,
    access: "owner",
  }),
  "add-model-provider": command<UiModel[]>()({
    decode: (params) => [decodeCustomProviderInput("add-model-provider", "input", params[0])] as const,
    access: "write",
    audit: { label: "added a model provider" },
  }),
  "inspect-system-prompt": command<SystemPromptInspection>()({
    decode: (params) => [decodeOptionalString("inspect-system-prompt", "threadId", params[0]), decodeOptionalString("inspect-system-prompt", "workspace", params[1])] as const,
    access: "read",
  }),
  "list-user-themes": command<UserTheme[]>()({
    decode: (params) => [decodeOptionalString("list-user-themes", "workspace", params[0])] as const,
    access: "read",
  }),
  "open-external-editor": command<ExternalEditorResult>()({
    decode: (params) => [decodeOptionalText("open-external-editor", "text", params[0])] as const,
    access: "write",
    audit: { label: "opened an external editor" },
  }),
  "client-call-result": command<void>()({
    decode: (params) => [decodeString("client-call-result", "callId", params[0]), params[1], decodeOptionalString("client-call-result", "error", params[2])] as const,
    access: "read",
  }),
  "start-job": command<{ jobId: string }, [method: string, params?: readonly unknown[]]>()({
    decode: (params) => [decodeString("start-job", "method", params[0]), params[1]] as const,
    access: "read",
  }),
  "cancel-job": command<{ cancelled: boolean }>()({
    decode: (params) => [decodeString("cancel-job", "jobId", params[0])] as const,
    access: "write",
    audit: { label: "cancelled a job" },
  }),
  "job-methods": command<string[]>()({
    decode: () => [] as const,
    access: "read",
  }),
  "host-extension": command<unknown>()({
    decode: (params) => [decodeExtensionId("host-extension", params[0]), decodeCommandName("host-extension", params[1]), params[2]] as const,
    access: "read",
  }),
} as const;
