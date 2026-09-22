import type {
  DesktopExtensionLoadResult,
  ExtensionInspection,
  HostBootstrap,
  UiImagePreview,
  WorkbenchBuildResult,
} from "../shared/contracts.js";
import { HOST_ERROR, jobMethodKey } from "../shared/host-transport.js";
import { decodeBadgeCount, decodeSystemNotification, type SystemNotification, type SystemNotificationOutcome } from "../shared/system-attention.js";
import type { PiHost } from "./pi-host.js";
import { defaultHostConfigManager } from "./host-config.js";
import { defaultUserThemeResolver } from "./user-themes.js";
import { openExternalEditor } from "./external-editor.js";
import { HostJobRunner, NO_JOB_CONTEXT, type HostMethodContext } from "./host-jobs.js";
import { WORKBENCH_CLIENT_PRINCIPAL, type HostInvocationPrincipal } from "./host-invocation.js";
import {
  decodeBoolean,
  decodeCommandName,
  decodeConfigPatch,
  decodeCustomProviderInput,
  decodeExtensionId,
  decodeExtensionUiAnswer,
  decodeHostTranscriptCursor,
  decodeNavigateOptions,
  decodeNewThreadConfiguration,
  decodeSettingKeys,
  decodeOptionalBoolean,
  decodeOptionalExtensionIds,
  decodeOptionalString,
  decodeOptionalText,
  decodePreparedPrompt,
  decodeSharedExports,
  decodeString,
  decodeStringOrClientTurnIdentity,
  decodeText,
  decodeUiPromptAttachments,
  decodeUiSkillDraft,
  decodeWorkbenchReloadMode,
} from "./ipc-input.js";

/** One method of the host protocol. Params arrive positionally and untrusted. */
export type HostMethod = (params: readonly unknown[], context: HostMethodContext) => Promise<unknown>;
export type HostMethodTable = Record<string, HostMethod>;

/** What a method needs from the machine the host runs on. */
export interface HostMethodPlatform {
  copyText(text: string): void;
  copyImage(dataUrl: string): void;
  readImagePreview(path: string): Promise<UiImagePreview | undefined>;
  inspectExtensions(cwd: string): Promise<ExtensionInspection>;
  /** `only` narrows the build to those extension ids; the client keeps every other module it has. */
  loadDesktopExtensions(cwd: string, sharedExports: Record<string, string[]>, only?: readonly string[]): Promise<DesktopExtensionLoadResult>;
  rebuildWorkbench(context: HostMethodContext, activeWorkspace: string): Promise<WorkbenchBuildResult>;
  workbenchSource(): Promise<string | undefined>;
  relaunchWorkbench(): void;
  /** Restarts into the downloaded update; false when none is waiting. */
  installUpdate(): boolean;
  /** Resolves once the user clicked or dismissed it; a click has already brought the window forward. */
  notify(notification: SystemNotification): Promise<SystemNotificationOutcome>;
  /** The count on the app's icon; 0 clears it. */
  setBadge(count: number): void;
}

/**
 * The half of the platform a client answers for itself. A window that is only
 * a protocol client implements exactly this and refuses the rest, so the
 * clipboard, the image preview and the workbench build stay where the user is
 * rather than travelling to the host process (ADR 0021).
 */
export interface ClientHostPlatform {
  copyText(text: string): void;
  copyImage(dataUrl: string): void;
  readImagePreview(path: string): Promise<UiImagePreview | undefined>;
  /** `cwd` is passed on as the client received it; only a host resolves an id. */
  loadDesktopExtensions(cwd: string, sharedExports: Record<string, string[]>, only?: readonly string[]): Promise<DesktopExtensionLoadResult>;
  rebuildWorkbench(context: HostMethodContext): Promise<WorkbenchBuildResult>;
  workbenchSource(): Promise<string | undefined>;
  relaunchWorkbench(): void;
  /** Restarts into the downloaded update; false when none is waiting. */
  installUpdate(): boolean;
  notify(notification: SystemNotification): Promise<SystemNotificationOutcome>;
  setBadge(count: number): void;
}

/**
 * The client-side half of the method table, for a window whose host lives in
 * another process. Its names are `CLIENT_SIDE_METHODS`; everything else in
 * that window's table refuses with `unsupported`.
 */
export function createClientHostMethods(platform: ClientHostPlatform): HostMethodTable {
  return {
    "copy-text": async (params) => platform.copyText(decodeString("copy-text", "text", params[0])),
    "copy-image": async (params) => platform.copyImage(decodeString("copy-image", "dataUrl", params[0])),
    "read-image-preview": async (params) => platform.readImagePreview(decodeString("read-image-preview", "path", params[0])),
    "desktop-extensions": async (params) => platform.loadDesktopExtensions(
      decodeString("desktop-extensions", "cwd", params[0]),
      decodeSharedExports("desktop-extensions", "sharedExports", params[1]),
      decodeOptionalExtensionIds("desktop-extensions", "only", params[2]),
    ),
    "rebuild-workbench": async (_params, context) => platform.rebuildWorkbench(context),
    "workbench-source": async () => ({ path: await platform.workbenchSource() }),
    "relaunch-workbench": async () => platform.relaunchWorkbench(),
    "install-update": async () => ({ installing: platform.installUpdate() }),
    "notify": async (params) => platform.notify(decodeSystemNotification("notify", params[0])),
    "set-badge": async (params) => platform.setBadge(decodeBadgeCount("set-badge", params[0])),
  };
}

export interface HostMethodDeps {
  /** Answers to the calls this host made into a client's process, when it makes any. */
  clientCalls?: { settle(callId: string, result: unknown, error?: string): void };
  /** Starts the host on the first call; later calls read what is already running. */
  bootstrap(): Promise<HostBootstrap>;
  /** Resolves once the host finished starting. */
  requireHost(): Promise<PiHost>;
  /** The host as it is, for calls that must not queue behind readiness. */
  host(): PiHost | undefined;
  jobs: HostJobRunner;
  platform: HostMethodPlatform;
}

const JOB_CONTROL_METHODS = new Set(["start-job", "cancel-job", "job-methods"]);

function decodePromptArgs(method: string, params: readonly unknown[]) {
  return {
    text: decodeText(method, "text", params[0]),
    attachments: decodeUiPromptAttachments(method, "attachments", params[1]),
    sessionId: decodeOptionalString(method, "sessionId", params[2]),
    clientMessageIdOrIdentity: decodeStringOrClientTurnIdentity(method, "clientMessageIdOrIdentity", params[3]),
    prepared: decodePreparedPrompt(method, "prepared", params[4]),
  };
}

/**
 * Every renderer-callable operation of the host, by protocol method name. The
 * table is the contract: a transport only moves frames in and out of it.
 */
export function createHostMethods(deps: HostMethodDeps): HostMethodTable {
  const { platform } = deps;
  const host = () => deps.requireHost();
  const invokeExtension = async (params: readonly unknown[], context: HostMethodContext): Promise<unknown> => {
    const extensionId = decodeExtensionId("host-extension", params[0]);
    const command = decodeCommandName("host-extension", params[1]);
    const instance = await host();
    return instance.invokeHostExtension(extensionId, command, params[2], context.principal);
  };
  // A client names a workspace by its id; one that still speaks paths sends a path.
  const workspace = async (method: string, name: string, value: unknown): Promise<string> =>
    (await host()).resolveWorkspacePath(decodeString(method, name, value));
  const optionalWorkspace = async (method: string, name: string, value: unknown): Promise<string | undefined> => {
    const named = decodeOptionalString(method, name, value);
    return named === undefined ? undefined : (await host()).resolveWorkspacePath(named);
  };

  const methods: HostMethodTable = {
    "bootstrap": async () => deps.bootstrap(),
    "transcript-page": async (params) => (await host()).loadTranscript(
      decodeString("transcript-page", "sessionId", params[0]),
      decodeHostTranscriptCursor("transcript-page", "cursor", params[1]),
    ),
    "prepare-prompt": async (params) => (await host()).preparePrompt(
      decodeText("prepare-prompt", "text", params[0]),
      decodeOptionalString("prepare-prompt", "sessionId", params[1]),
      decodeUiSkillDraft("prepare-prompt", "skill", params[2]),
      decodeOptionalString("prepare-prompt", "backendKind", params[3]),
    ),
    "prompt": async (params) => {
      const args = decodePromptArgs("prompt", params);
      return (await host()).prompt(args.text, args.attachments, args.sessionId, args.clientMessageIdOrIdentity, args.prepared);
    },
    "run-shell-action": async (params) => (await host()).runShellAction(
      decodeString("run-shell-action", "command", params[0]),
      decodeOptionalBoolean("run-shell-action", "includeInContext", params[1]),
      await optionalWorkspace("run-shell-action", "expectedCwd", params[2]),
    ),
    "steer": async (params) => {
      const args = decodePromptArgs("steer", params);
      return (await host()).steer(args.text, args.attachments, args.sessionId, args.clientMessageIdOrIdentity, args.prepared);
    },
    "follow-up": async (params) => {
      const args = decodePromptArgs("follow-up", params);
      return (await host()).followUp(args.text, args.attachments, args.sessionId, args.clientMessageIdOrIdentity, args.prepared);
    },
    // Stopping must not queue behind host readiness: a thread stuck on a question
    // is exactly what the user is trying to get out of.
    "abort": async (params) => deps.host()?.abort(decodeOptionalString("abort", "sessionId", params[0])),
    "new-session": async (params) => (await host()).newSession(
      decodeOptionalText("new-session", "initialPrompt", params[0]),
      decodeUiPromptAttachments("new-session", "attachments", params[1]),
      await optionalWorkspace("new-session", "cwd", params[2]),
      decodeStringOrClientTurnIdentity("new-session", "clientMessageIdOrRequestId", params[3]),
      decodePreparedPrompt("new-session", "prepared", params[4]),
      decodeNewThreadConfiguration("new-session", "configuration", params[5]),
    ),
    "prepared-thread-capability": async (params) =>
      (await host()).getPreparedThreadCapability(await optionalWorkspace("prepared-thread-capability", "cwd", params[0])),
    "fork-thread": async (params) => (await host()).forkThread(
      decodeString("fork-thread", "entryId", params[0]),
      decodeOptionalString("fork-thread", "expectedSessionId", params[1]),
    ),
    "thread-tree": async (params) => (await host()).threadTree(decodeOptionalString("thread-tree", "sessionId", params[0])),
    "navigate-thread-tree": async (params) => (await host()).navigateThreadTree(
      decodeString("navigate-thread-tree", "entryId", params[0]),
      decodeNavigateOptions("navigate-thread-tree", "options", params[1]),
      decodeOptionalString("navigate-thread-tree", "expectedSessionId", params[2]),
    ),
    "duplicate-thread": async (params) => (await host()).duplicateThread(decodeOptionalString("duplicate-thread", "expectedSessionId", params[0])),
    "switch-session": async (params) => (await host()).switchSession(decodeString("switch-session", "path", params[0])),
    "set-model": async (params) => (await host()).setModel(
      decodeString("set-model", "provider", params[0]),
      decodeString("set-model", "id", params[1]),
    ),
    "set-thinking": async (params) => (await host()).setThinkingLevel(decodeString("set-thinking", "level", params[0])),
    "compact-context": async () => (await host()).compactContext(),
    "reload-runtime": async () => (await host()).reloadRuntime(),
    "reload-extensions": async () => (await host()).reloadExtensions(),
    // Answering must never wait for a ready host: the host is blocked on this very
    // question, so requiring readiness here would deadlock startup.
    "answer-extension-ui": async (params) => deps.host()?.answerExtensionUi(
      decodeString("answer-extension-ui", "id", params[0]),
      decodeExtensionUiAnswer("answer-extension-ui", "answer", params[1]),
    ),
    "sync-extension-ui": async () => deps.host()?.replayOpenUiPrompts(),
    "recover-thread": async () => (await host()).recoverThread(),
    "rename-thread": async (params) => (await host()).renameThread(
      decodeString("rename-thread", "title", params[0]),
      decodeOptionalString("rename-thread", "expectedSessionId", params[1]),
    ),
    "copy-text": async (params) => platform.copyText(decodeString("copy-text", "text", params[0])),
    "copy-image": async (params) => platform.copyImage(decodeString("copy-image", "dataUrl", params[0])),
    "notify": async (params) => platform.notify(decodeSystemNotification("notify", params[0])),
    "set-badge": async (params) => platform.setBadge(decodeBadgeCount("set-badge", params[0])),
    "read-tool-output": async (params) => (await host()).readToolOutput(
      decodeString("read-tool-output", "sessionId", params[0]),
      decodeString("read-tool-output", "toolCallId", params[1]),
    ),
    // Answers with the text rather than copying it: the clipboard belongs to
    // the client, which may be a different process than the host.
    "copy-thread-markdown": async (params) =>
      (await host()).exportThreadMarkdown(decodeOptionalString("copy-thread-markdown", "expectedSessionId", params[0])),
    "read-image-preview": async (params) => platform.readImagePreview(decodeString("read-image-preview", "path", params[0])),
    // Host extensions reach the renderer through this single method; core does
    // not grow a method per feature. `input` stays unknown: the extension owns it.
    "host-extension": invokeExtension,
    "host-extensions": async () => (await host()).listHostExtensions(),
    "inspect-extensions": async (params) => platform.inspectExtensions(await workspace("inspect-extensions", "cwd", params[0])),
    "host-extension-active": async (params) => (await host()).setHostExtensionActive(
      decodeString("host-extension-active", "id", params[0]),
      decodeBoolean("host-extension-active", "active", params[1]),
    ),
    "extension-grant": async (params) => (await host()).grantExtension(
      decodeExtensionId("extension-grant", params[0]),
      decodeBoolean("extension-grant", "grant", params[1]),
    ),
    "prepare-workbench-reload": async (params) =>
      (await host()).prepareWorkbenchReload(decodeWorkbenchReloadMode("prepare-workbench-reload", "mode", params[0])),
    "release-workbench-reload": async () => (await host()).releaseWorkbenchReload(),
    "desktop-extensions": async (params) => platform.loadDesktopExtensions(
      await workspace("desktop-extensions", "cwd", params[0]),
      decodeSharedExports("desktop-extensions", "sharedExports", params[1]),
      decodeOptionalExtensionIds("desktop-extensions", "only", params[2]),
    ),
    "rebuild-workbench": async (_params, context) => platform.rebuildWorkbench(context, (await host()).activeWorkspacePath()),
    "workbench-source": async () => ({ path: await platform.workbenchSource() }),
    "relaunch-workbench": async () => platform.relaunchWorkbench(),
    "install-update": async () => ({ installing: platform.installUpdate() }),
    "open-project": async (params) => (await host()).setWorkspace(await workspace("open-project", "workspace", params[0])),
    "remove-project": async (params) => (await host()).removeProject(await workspace("remove-project", "workspace", params[0])),
    "get-config": async (params) => defaultHostConfigManager.read(await optionalWorkspace("get-config", "workspace", params[0])),
    "update-config": async (params) => {
      const patch = decodeConfigPatch("update-config", "patch", params[0]);
      const scope = params[1] === "project" ? "project" : "global";
      return defaultHostConfigManager.update(patch, scope, await optionalWorkspace("update-config", "workspace", params[2]));
    },
    "get-config-layers": async (params) => defaultHostConfigManager.readLayers(await optionalWorkspace("get-config-layers", "workspace", params[0])),
    "clear-config": async (params) => {
      const keys = decodeSettingKeys("clear-config", "keys", params[0]);
      const scope = params[1] === "project" ? "project" : "global";
      return defaultHostConfigManager.clear(keys, scope, await optionalWorkspace("clear-config", "workspace", params[2]));
    },
    "get-models-config": async () => (await host()).modelsConfig(),
    "add-model-provider": async (params) => (await host()).addModelProvider(decodeCustomProviderInput("add-model-provider", "input", params[0])),
    "inspect-system-prompt": async (params) => (await host()).inspectSystemPrompt(
      decodeOptionalString("inspect-system-prompt", "threadId", params[0]),
      await optionalWorkspace("inspect-system-prompt", "workspace", params[1]),
    ),
    "list-user-themes": async (params) => {
      const workspacePath = await optionalWorkspace("list-user-themes", "workspace", params[0]);
      return defaultUserThemeResolver.list(workspacePath);
    },
    "open-external-editor": async (params) => {
      const text = decodeOptionalText("open-external-editor", "text", params[0]) ?? "";
      return openExternalEditor({ initialText: text });
    },

    // The other direction of the protocol: a client answering a `client-call`.
    "client-call-result": async (params) => {
      deps.clientCalls?.settle(
        decodeString("client-call-result", "callId", params[0]),
        params[1],
        decodeOptionalString("client-call-result", "error", params[2]),
      );
    },

    "start-job": async (params, context) => {
      const method = decodeString("start-job", "method", params[0]);
      if (JOB_CONTROL_METHODS.has(method)) throw new Error(`start-job: ${method} cannot run as a job`);
      const target = methods[method];
      if (!target) throw Object.assign(new Error(`Unknown method "${method}".`), { code: HOST_ERROR.unknownMethod });
      const jobParams = params[1] === undefined ? [] : params[1];
      if (!Array.isArray(jobParams)) throw new Error("start-job: params must be an array");
      return { jobId: deps.jobs.start((jobContext) => target(jobParams as unknown[], jobContext), context.principal) };
    },
    "cancel-job": async (params) => ({ cancelled: deps.jobs.cancel(decodeString("cancel-job", "jobId", params[0])) }),
    /** Which calls a client should run as jobs; a host extension marks its own long commands. */
    "job-methods": async () => {
      const long = deps.host()?.longHostExtensionCommands() ?? [];
      return [
        "rebuild-workbench",
        ...long.map((entry) => {
          const [extensionId = "", command = ""] = entry.split("/");
          return jobMethodKey("host-extension", extensionId, command);
        }),
      ];
    },
  };
  return methods;
}

/**
 * Every method name, all refusing. A window pointed at a host on another
 * machine still has its in-process transport, but nothing local may answer for
 * that host: a stray call gets a reason instead of this machine's state.
 */
export function createUnsupportedHostMethods(reason: string): HostMethodTable {
  const refuse = (): never => { throw Object.assign(new Error(reason), { code: HOST_ERROR.unsupported }); };
  const names = Object.keys(createHostMethods({
    bootstrap: refuse,
    requireHost: refuse,
    host: () => undefined,
    jobs: new HostJobRunner(() => undefined),
    platform: {
      copyText: refuse,
      copyImage: refuse,
      readImagePreview: refuse,
      inspectExtensions: refuse,
      loadDesktopExtensions: refuse,
      rebuildWorkbench: refuse,
      workbenchSource: refuse,
      relaunchWorkbench: refuse,
      installUpdate: refuse,
      notify: refuse,
      setBadge: refuse,
    },
  }));
  return Object.fromEntries(names.map((name) => [name, async () => refuse()]));
}

/** Runs one method outside a job; used by the request path of every transport. */
export async function invokeHostMethod(
  methods: HostMethodTable,
  method: string,
  params: readonly unknown[],
  principal: HostInvocationPrincipal = WORKBENCH_CLIENT_PRINCIPAL,
): Promise<unknown> {
  const handler = methods[method];
  if (!handler) throw Object.assign(new Error(`Unknown method "${method}".`), { code: HOST_ERROR.unknownMethod });
  return handler(params, { ...NO_JOB_CONTEXT, principal });
}
