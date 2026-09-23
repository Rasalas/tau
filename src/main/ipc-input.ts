import type {
  ClientTurnIdentity,
  CustomProviderInput,
  ExtensionUiAnswer,
  NewThreadConfiguration,
  PreparedPrompt,
  RuntimeCapabilities,
  TauConfig,
  ThreadBackendKind,
  UiPromptAttachment,
  UiSkillDraft,
  UiSkillInvocation,
  WorkbenchReloadMode,
} from "../shared/contracts.js";
import { createNewThreadRequestId } from "../shared/contracts.js";
import { isHostTranscriptCursor, type HostTranscriptCursor } from "../shared/transcript-cursor.js";
import { isUpdateChannel } from "../shared/app-version.js";

/**
 * Hand-written decoders for every renderer→host IPC argument, in the style of
 * `../shared/host-protocol.ts`: no library, no echoing the rejected payload
 * back to the caller. Each handler in `index.ts` decodes before calling the
 * host, so an untrusted or stale renderer cannot hand PiHost a value it never
 * checked the shape of.
 */

function fail(channel: string, field: string, reason: string): never {
  throw new Error(`${channel}: ${field} ${reason}`);
}

function record(channel: string, field: string, value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(channel, field, "must be an object");
  return value as Record<string, unknown>;
}

export function decodeString(channel: string, field: string, value: unknown): string {
  if (typeof value !== "string" || value.length === 0) fail(channel, field, "must be a non-empty string");
  return value;
}

/** Prompt text may be empty when only attachments are sent (App allows it); only the type is checked. */
export function decodeText(channel: string, field: string, value: unknown): string {
  if (typeof value !== "string") fail(channel, field, "must be a string");
  return value;
}

export function decodeOptionalText(channel: string, field: string, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return decodeText(channel, field, value);
}

export function decodeOptionalString(channel: string, field: string, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return decodeString(channel, field, value);
}

export function decodeBoolean(channel: string, field: string, value: unknown): boolean {
  if (typeof value !== "boolean") fail(channel, field, "must be a boolean");
  return value;
}

export function decodeOptionalBoolean(channel: string, field: string, value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  return decodeBoolean(channel, field, value);
}

function decodeNumber(channel: string, field: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(channel, field, "must be a finite number");
  return value;
}

function decodeUiPromptAttachment(channel: string, field: string, value: unknown): UiPromptAttachment {
  const item = record(channel, field, value);
  if (item.kind === "file") {
    return {
      kind: "file",
      name: decodeString(channel, `${field}.name`, item.name),
      mimeType: decodeString(channel, `${field}.mimeType`, item.mimeType),
      path: decodeString(channel, `${field}.path`, item.path),
      size: decodeNumber(channel, `${field}.size`, item.size),
    };
  }
  if (item.kind !== "image") fail(channel, `${field}.kind`, 'must be "image" or "file"');
  return {
    kind: "image",
    name: decodeString(channel, `${field}.name`, item.name),
    mimeType: decodeString(channel, `${field}.mimeType`, item.mimeType),
    data: decodeString(channel, `${field}.data`, item.data),
    size: decodeNumber(channel, `${field}.size`, item.size),
  };
}

export function decodeUiPromptAttachments(channel: string, field: string, value: unknown): UiPromptAttachment[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) fail(channel, field, "must be an array");
  return value.map((item, index) => decodeUiPromptAttachment(channel, `${field}[${index}]`, item));
}

export function decodeNewThreadConfiguration(channel: string, field: string, value: unknown): NewThreadConfiguration | undefined {
  if (value === undefined) return undefined;
  const item = record(channel, field, value);
  const mode = item.mode === undefined ? undefined : decodeString(channel, `${field}.mode`, item.mode);
  const model = item.model === undefined ? undefined : record(channel, `${field}.model`, item.model);
  return {
    ...(model ? {
      model: {
        provider: decodeString(channel, `${field}.model.provider`, model.provider),
        id: decodeString(channel, `${field}.model.id`, model.id),
      },
    } : {}),
    ...(mode ? { mode } : {}),
  };
}

export function decodeClientTurnIdentity(channel: string, field: string, value: unknown): ClientTurnIdentity {
  const item = record(channel, field, value);
  return {
    clientTurnId: decodeString(channel, `${field}.clientTurnId`, item.clientTurnId),
    clientMessageId: decodeString(channel, `${field}.clientMessageId`, item.clientMessageId),
    ...(item.newThreadRequestId !== undefined
      ? { newThreadRequestId: createNewThreadRequestId(decodeString(channel, `${field}.newThreadRequestId`, item.newThreadRequestId)) }
      : {}),
  };
}

export function decodeStringOrClientTurnIdentity(channel: string, field: string, value: unknown): string | ClientTurnIdentity | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  return decodeClientTurnIdentity(channel, field, value);
}

function decodeRuntimeCapabilities(channel: string, field: string, value: unknown): RuntimeCapabilities {
  const item = record(channel, field, value);
  return {
    skillInvocationDialect: decodeString(channel, `${field}.skillInvocationDialect`, item.skillInvocationDialect),
    ...(item.ownsModelSelection !== undefined ? { ownsModelSelection: decodeBoolean(channel, `${field}.ownsModelSelection`, item.ownsModelSelection) } : {}),
    ...(item.interactiveApprovals !== undefined ? { interactiveApprovals: decodeBoolean(channel, `${field}.interactiveApprovals`, item.interactiveApprovals) } : {}),
  };
}

function decodeUiSkillInvocation(channel: string, field: string, value: unknown): UiSkillInvocation {
  const item = record(channel, field, value);
  return {
    name: decodeString(channel, `${field}.name`, item.name),
    command: decodeString(channel, `${field}.command`, item.command),
    copyText: decodeString(channel, `${field}.copyText`, item.copyText),
  };
}

export function decodePreparedPrompt(channel: string, field: string, value: unknown): PreparedPrompt | undefined {
  if (value === undefined) return undefined;
  const item = record(channel, field, value);
  return {
    ...(item.tauThreadId !== undefined ? { tauThreadId: decodeString(channel, `${field}.tauThreadId`, item.tauThreadId) } : {}),
    ...(item.providerSessionId !== undefined ? { providerSessionId: decodeString(channel, `${field}.providerSessionId`, item.providerSessionId) } : {}),
    ...(item.sessionId !== undefined ? { sessionId: decodeString(channel, `${field}.sessionId`, item.sessionId) } : {}),
    backendKind: decodeString(channel, `${field}.backendKind`, item.backendKind) as ThreadBackendKind,
    runtimeCapabilities: decodeRuntimeCapabilities(channel, `${field}.runtimeCapabilities`, item.runtimeCapabilities),
    visibleText: decodeString(channel, `${field}.visibleText`, item.visibleText),
    runtimeText: decodeString(channel, `${field}.runtimeText`, item.runtimeText),
    ...(item.skill !== undefined ? { skill: decodeUiSkillInvocation(channel, `${field}.skill`, item.skill) } : {}),
    sourceFingerprint: decodeString(channel, `${field}.sourceFingerprint`, item.sourceFingerprint),
  };
}

export function decodeUiSkillDraft(channel: string, field: string, value: unknown): UiSkillDraft | undefined {
  if (value === undefined) return undefined;
  const item = record(channel, field, value);
  if (item.source !== "skill") fail(channel, `${field}.source`, 'must be "skill"');
  return {
    source: "skill",
    name: decodeString(channel, `${field}.name`, item.name),
    visibleText: decodeString(channel, `${field}.visibleText`, item.visibleText),
    command: decodeString(channel, `${field}.command`, item.command),
  };
}

/** The cursor is opaque to core; only its runtime representation (a non-empty string) is checked. */
export function decodeHostTranscriptCursor(channel: string, field: string, value: unknown): HostTranscriptCursor | undefined {
  if (value === undefined) return undefined;
  if (!isHostTranscriptCursor(value)) fail(channel, field, "must be a non-empty string cursor");
  return value;
}

export function decodeNavigateOptions(channel: string, field: string, value: unknown): { summarize?: boolean } | undefined {
  if (value === undefined) return undefined;
  const item = record(channel, field, value);
  return item.summarize !== undefined ? { summarize: decodeBoolean(channel, `${field}.summarize`, item.summarize) } : {};
}

export function decodeExtensionUiAnswer(channel: string, field: string, value: unknown): ExtensionUiAnswer {
  const item = record(channel, field, value);
  if ("cancelled" in item) {
    if (item.cancelled !== true) fail(channel, `${field}.cancelled`, "must be true");
    return { cancelled: true };
  }
  if ("confirmed" in item) return { confirmed: decodeBoolean(channel, `${field}.confirmed`, item.confirmed) };
  if ("customResult" in item) return { customResult: item.customResult };
  if ("value" in item) {
    return {
      value: decodeString(channel, `${field}.value`, item.value),
      ...(item.typed !== undefined ? { typed: decodeBoolean(channel, `${field}.typed`, item.typed) } : {}),
    };
  }
  fail(channel, field, 'must have "cancelled", "confirmed", "customResult" or "value"');
}

const WORKBENCH_RELOAD_MODES = new Set<string>(["inspect", "wait", "abort"]);

export function decodeWorkbenchReloadMode(channel: string, field: string, value: unknown): WorkbenchReloadMode {
  if (typeof value !== "string" || !WORKBENCH_RELOAD_MODES.has(value)) fail(channel, field, 'must be "inspect", "wait" or "abort"');
  return value as WorkbenchReloadMode;
}

export function decodeSharedExports(channel: string, field: string, value: unknown): Record<string, string[]> {
  const item = record(channel, field, value);
  const result: Record<string, string[]> = {};
  for (const [key, exports] of Object.entries(item)) {
    if (!Array.isArray(exports) || exports.some((entry) => typeof entry !== "string")) fail(channel, `${field}.${key}`, "must be an array of strings");
    result[key] = exports as string[];
  }
  return result;
}

/** Mirrors the manifest id grammar in extension-packages.ts: lowercase, dot-separated. */
const EXTENSION_ID = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/u;
/** A plain lowercase identifier, matching the names extensions pass to registerCommand. */
const COMMAND_NAME = /^[a-z][a-z0-9-]*$/u;

/** An optional list of manifest ids: which extensions a call is narrowed to. */
export function decodeOptionalExtensionIds(channel: string, field: string, value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) fail(channel, field, "must be an array of extension ids");
  for (const entry of value as unknown[]) {
    if (typeof entry !== "string" || !EXTENSION_ID.test(entry)) fail(channel, field, "must hold manifest ids (lowercase, dot-separated)");
  }
  return [...new Set(value as string[])];
}

export function decodeExtensionId(channel: string, value: unknown): string {
  const id = decodeString(channel, "extensionId", value);
  if (!EXTENSION_ID.test(id)) fail(channel, "extensionId", "must look like a manifest id (lowercase, dot-separated)");
  return id;
}

export function decodeCommandName(channel: string, value: unknown): string {
  const command = decodeString(channel, "command", value);
  if (!COMMAND_NAME.test(command)) fail(channel, "command", "must be a plain lowercase identifier");
  return command;
}

/**
 * Decodes the payload for the `add-model-provider` IPC method.
 * Checks object shape before it reaches `validateProviderInput` and `addModelProvider`,
 * so a null/string/array payload produces a clean fail() message instead of a TypeError.
 */
export function decodeCustomProviderInput(channel: string, field: string, value: unknown): CustomProviderInput {
  const item = record(channel, field, value);
  const rawModels = item.models;
  if (!Array.isArray(rawModels) || rawModels.length === 0)
    fail(channel, `${field}.models`, "must be a non-empty array");
  return {
    providerId: decodeString(channel, `${field}.providerId`, item.providerId),
    ...(item.name !== undefined ? { name: decodeString(channel, `${field}.name`, item.name) } : {}),
    ...(item.baseUrl !== undefined ? { baseUrl: decodeString(channel, `${field}.baseUrl`, item.baseUrl) } : {}),
    ...(item.api !== undefined ? { api: decodeString(channel, `${field}.api`, item.api) } : {}),
    ...(item.apiKey !== undefined ? { apiKey: decodeString(channel, `${field}.apiKey`, item.apiKey) } : {}),
    models: (rawModels as unknown[]).map((m, i) => {
      const md = record(channel, `${field}.models[${i}]`, m);
      return {
        id: decodeString(channel, `${field}.models[${i}].id`, md.id),
        ...(md.name !== undefined ? { name: decodeString(channel, `${field}.models[${i}].name`, md.name) } : {}),
        ...(md.reasoning !== undefined ? { reasoning: decodeBoolean(channel, `${field}.models[${i}].reasoning`, md.reasoning) } : {}),
        ...(md.contextWindow !== undefined ? { contextWindow: decodeNumber(channel, `${field}.models[${i}].contextWindow`, md.contextWindow) } : {}),
        ...(md.maxTokens !== undefined ? { maxTokens: decodeNumber(channel, `${field}.models[${i}].maxTokens`, md.maxTokens) } : {}),
      };
    }),
  };
}

/** Setting keys for `clear-config`: `showCosts`, or a record entry such as `values.tau.usage.period`. */
export function decodeSettingKeys(channel: string, field: string, value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) fail(channel, field, "must be a list of 1 to 100 setting keys");
  for (const key of value as unknown[]) {
    if (typeof key !== "string" || key.length === 0 || key.length > 300) fail(channel, field, "must hold non-empty setting keys");
  }
  return value as string[];
}

const TRANSCRIPT_DETAIL_VALUES = new Set(["focused", "detailed", "everything"]);

/**
 * Decodes the patch payload for `update-config`. Accepts only known TauConfig top-level keys
 * with their expected types; unknown keys are silently dropped. This re-establishes the
 * decode-every-argument invariant for a method that previously used a raw `as` cast.
 */
export function decodeConfigPatch(channel: string, field: string, value: unknown): Partial<TauConfig> {
  const item = record(channel, field, value);
  const result: Partial<TauConfig> = {};
  if (item.theme !== undefined) result.theme = decodeString(channel, `${field}.theme`, item.theme);
  if (item.transcriptDetail !== undefined) {
    const td = decodeString(channel, `${field}.transcriptDetail`, item.transcriptDetail);
    if (!TRANSCRIPT_DETAIL_VALUES.has(td)) fail(channel, `${field}.transcriptDetail`, 'must be "focused", "detailed" or "everything"');
    result.transcriptDetail = td as TauConfig["transcriptDetail"];
  }
  if (item.showCosts !== undefined) result.showCosts = decodeBoolean(channel, `${field}.showCosts`, item.showCosts);
  if (item.prewarm !== undefined) result.prewarm = decodeBoolean(channel, `${field}.prewarm`, item.prewarm);
  if (item.hostBackground !== undefined) result.hostBackground = decodeBoolean(channel, `${field}.hostBackground`, item.hostBackground);
  if (item.vimMode !== undefined) result.vimMode = decodeBoolean(channel, `${field}.vimMode`, item.vimMode);
  if (item.threads !== undefined) {
    const threads = record(channel, `${field}.threads`, item.threads);
    if (threads.continueAfterRestart !== undefined) {
      result.threads = { continueAfterRestart: decodeBoolean(channel, `${field}.threads.continueAfterRestart`, threads.continueAfterRestart) };
    }
  }
  if (item.updates !== undefined) {
    const updates = record(channel, `${field}.updates`, item.updates);
    if (updates.channel !== undefined) {
      if (!isUpdateChannel(updates.channel)) fail(channel, `${field}.updates.channel`, 'must be "stable" or "nightly"');
      result.updates = { channel: updates.channel };
    }
  }
  if (item.fontFamily !== undefined) result.fontFamily = decodeString(channel, `${field}.fontFamily`, item.fontFamily);
  if (item.fontSize !== undefined) result.fontSize = decodeNumber(channel, `${field}.fontSize`, item.fontSize);
  if (item.temperature !== undefined) result.temperature = decodeNumber(channel, `${field}.temperature`, item.temperature);
  if (item.maxTokens !== undefined) result.maxTokens = decodeNumber(channel, `${field}.maxTokens`, item.maxTokens);
  if (item.favouriteModels !== undefined) {
    if (!Array.isArray(item.favouriteModels) || (item.favouriteModels as unknown[]).some((m) => typeof m !== "string"))
      fail(channel, `${field}.favouriteModels`, "must be an array of strings");
    result.favouriteModels = item.favouriteModels as string[];
  }
  if (item.disabledExtensions !== undefined) {
    if (!Array.isArray(item.disabledExtensions) || (item.disabledExtensions as unknown[]).some((m) => typeof m !== "string"))
      fail(channel, `${field}.disabledExtensions`, "must be an array of strings");
    result.disabledExtensions = item.disabledExtensions as string[];
  }
  if (item.options !== undefined) {
    const opts = record(channel, `${field}.options`, item.options);
    if (Object.values(opts).some((v) => typeof v !== "boolean")) fail(channel, `${field}.options`, "must be a Record<string, boolean>");
    result.options = opts as Record<string, boolean>;
  }
  if (item.values !== undefined) {
    const vals = record(channel, `${field}.values`, item.values);
    if (Object.values(vals).some((v) => typeof v !== "string")) fail(channel, `${field}.values`, "must be a Record<string, string>");
    result.values = vals as Record<string, string>;
  }
  if (item.keybindings !== undefined) {
    const kb = record(channel, `${field}.keybindings`, item.keybindings);
    if (Object.values(kb).some((v) => typeof v !== "string")) fail(channel, `${field}.keybindings`, "must be a Record<string, string>");
    result.keybindings = kb as Record<string, string>;
  }
  if (item.models !== undefined) {
    const m = record(channel, `${field}.models`, item.models);
    result.models = {
      ...(m.default !== undefined ? { default: decodeString(channel, `${field}.models.default`, m.default) } : {}),
      ...(m.thinkingLevel !== undefined ? { thinkingLevel: decodeString(channel, `${field}.models.thinkingLevel`, m.thinkingLevel) } : {}),
    };
  }
  if (item.compaction !== undefined) {
    const c = record(channel, `${field}.compaction`, item.compaction);
    result.compaction = {
      ...(c.enabled !== undefined ? { enabled: decodeBoolean(channel, `${field}.compaction.enabled`, c.enabled) } : {}),
      ...(c.reserveTokens !== undefined ? { reserveTokens: decodeNumber(channel, `${field}.compaction.reserveTokens`, c.reserveTokens) } : {}),
      ...(c.keepRecentTokens !== undefined ? { keepRecentTokens: decodeNumber(channel, `${field}.compaction.keepRecentTokens`, c.keepRecentTokens) } : {}),
    };
  }
  if (item.retry !== undefined) {
    const r = record(channel, `${field}.retry`, item.retry);
    const provider = r.provider !== undefined ? record(channel, `${field}.retry.provider`, r.provider) : undefined;
    result.retry = {
      ...(r.enabled !== undefined ? { enabled: decodeBoolean(channel, `${field}.retry.enabled`, r.enabled) } : {}),
      ...(r.maxRetries !== undefined ? { maxRetries: decodeNumber(channel, `${field}.retry.maxRetries`, r.maxRetries) } : {}),
      ...(r.baseDelayMs !== undefined ? { baseDelayMs: decodeNumber(channel, `${field}.retry.baseDelayMs`, r.baseDelayMs) } : {}),
      ...(provider ? {
        provider: {
          ...(provider.timeoutMs !== undefined ? { timeoutMs: decodeNumber(channel, `${field}.retry.provider.timeoutMs`, provider.timeoutMs) } : {}),
          ...(provider.maxRetries !== undefined ? { maxRetries: decodeNumber(channel, `${field}.retry.provider.maxRetries`, provider.maxRetries) } : {}),
          ...(provider.maxRetryDelayMs !== undefined ? { maxRetryDelayMs: decodeNumber(channel, `${field}.retry.provider.maxRetryDelayMs`, provider.maxRetryDelayMs) } : {}),
        },
      } : {}),
    };
  }
  if (item.steeringMode !== undefined) {
    const sm = decodeString(channel, `${field}.steeringMode`, item.steeringMode);
    if (sm !== "all" && sm !== "one-at-a-time") fail(channel, `${field}.steeringMode`, 'must be "all" or "one-at-a-time"');
    result.steeringMode = sm as TauConfig["steeringMode"];
  }
  if (item.followUpMode !== undefined) {
    const fm = decodeString(channel, `${field}.followUpMode`, item.followUpMode);
    if (fm !== "all" && fm !== "one-at-a-time") fail(channel, `${field}.followUpMode`, 'must be "all" or "one-at-a-time"');
    result.followUpMode = fm as TauConfig["followUpMode"];
  }
  if (item.defaultTools !== undefined) {
    if (!Array.isArray(item.defaultTools) || (item.defaultTools as unknown[]).some((t) => typeof t !== "string"))
      fail(channel, `${field}.defaultTools`, "must be an array of strings");
    result.defaultTools = item.defaultTools as string[];
  }
  if (item.shellPath !== undefined) result.shellPath = decodeString(channel, `${field}.shellPath`, item.shellPath);
  if (item.shellCommandPrefix !== undefined) result.shellCommandPrefix = decodeString(channel, `${field}.shellCommandPrefix`, item.shellCommandPrefix);
  if (item.npmCommand !== undefined) {
    if (!Array.isArray(item.npmCommand) || (item.npmCommand as unknown[]).some((a) => typeof a !== "string"))
      fail(channel, `${field}.npmCommand`, "must be an array of strings");
    result.npmCommand = item.npmCommand as string[];
  }
  if (item.quietStartup !== undefined) result.quietStartup = decodeBoolean(channel, `${field}.quietStartup`, item.quietStartup);
  if (item.defaultProjectTrust !== undefined) {
    const dpt = decodeString(channel, `${field}.defaultProjectTrust`, item.defaultProjectTrust);
    if (dpt !== "ask" && dpt !== "always" && dpt !== "never") fail(channel, `${field}.defaultProjectTrust`, 'must be "ask", "always" or "never"');
    result.defaultProjectTrust = dpt as TauConfig["defaultProjectTrust"];
  }
  return result;
}

// `input` for a host extension command is intentionally left as `unknown`:
// ADR 0006 has core route by id without inspecting the payload, and the
// extension owns validating its own untrusted input.
