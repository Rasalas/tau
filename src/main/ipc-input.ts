import type {
  ClientTurnIdentity,
  ExtensionUiAnswer,
  NewThreadConfiguration,
  PreparedPrompt,
  RuntimeCapabilities,
  ThreadBackendKind,
  UiPromptAttachment,
  UiSkillDraft,
  UiSkillInvocation,
  WorkbenchReloadMode,
} from "../shared/contracts.js";
import { createNewThreadRequestId } from "../shared/contracts.js";
import { isHostTranscriptCursor, type HostTranscriptCursor } from "../shared/transcript-cursor.js";

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
  if (item.kind !== "image") fail(channel, `${field}.kind`, 'must be "image"');
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
  if (item.model === undefined) return {};
  const model = record(channel, `${field}.model`, item.model);
  return {
    model: {
      provider: decodeString(channel, `${field}.model.provider`, model.provider),
      id: decodeString(channel, `${field}.model.id`, model.id),
    },
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
  if ("value" in item) {
    return {
      value: decodeString(channel, `${field}.value`, item.value),
      ...(item.typed !== undefined ? { typed: decodeBoolean(channel, `${field}.typed`, item.typed) } : {}),
    };
  }
  fail(channel, field, 'must have "cancelled", "confirmed" or "value"');
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

// `input` for a host extension command is intentionally left as `unknown`:
// ADR 0006 has core route by id without inspecting the payload, and the
// extension owns validating its own untrusted input.
