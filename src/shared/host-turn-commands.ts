import { HOST_TURN_COMMAND_METADATA } from "./host-command-metadata.js";
import type { ClientTurnIdentity, PreparedPrompt, PreparedThreadCapability, UiQueuedPrompt, ShellActionResult, UiComposerCommand, UiPromptAttachment, UiSkillDraft } from "./contracts.js";
import type { HostActionResult, NewThreadResult } from "./host-protocol.js";
import { attachCommandMetadata, command } from "./host-command-definition.js";
import {
  decodeString, decodeText, decodeOptionalString, decodeOptionalText, decodeOptionalBoolean,
  decodeUiPromptAttachments, decodeUiSkillDraft, decodeStringOrClientTurnIdentity,
  decodePreparedPrompt, decodeNewThreadConfiguration, decodeThreadStartOptions,
  decodeThreadDelivery, decodeCompactionPrompt, decodeClientTurnIdentity,
} from "./host-command-input.js";

function promptArgs(method: string, params: readonly unknown[]) {
  return [decodeText(method, "text", params[0]), decodeUiPromptAttachments(method, "attachments", params[1]), decodeOptionalString(method, "sessionId", params[2]), decodeStringOrClientTurnIdentity(method, "clientMessageIdOrIdentity", params[3]), decodePreparedPrompt(method, "prepared", params[4])] as const;
}
function decodeIndex(method: string, value: unknown) {
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`${method}: toIndex must be an integer.`);
  return value;
}
/** A planned message's time: epoch ms, or nothing for one that waits for the turn. */
function decodeDeliverAt(channel: string, value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error(`${channel}: deliverAt must be a time in epoch milliseconds.`);
  return value;
}
function resumeWhen(value: unknown) {
  const when = decodeString("resume-limited", "when", value);
  if (when !== "now" && when !== "reset" && when !== "cancel") throw new Error('resume-limited: "when" must be "now", "reset" or "cancel".');
  return when;
}
function goalAction(value: unknown) {
  const action = decodeString("thread-goal", "action", value);
  if (action !== "set" && action !== "pause" && action !== "resume" && action !== "clear" && action !== "dismiss") throw new Error('thread-goal: "action" must be set, pause, resume, clear or dismiss.');
  return action;
}

export const HOST_TURN_COMMANDS = attachCommandMetadata(HOST_TURN_COMMAND_METADATA, {
  "prepare-prompt": command<PreparedPrompt | undefined>()({
    audit: { label: "prepared a prompt", thread: 1, automatic: true },
    decode: (p) => [decodeText("prepare-prompt", "text", p[0]), decodeOptionalString("prepare-prompt", "sessionId", p[1]), decodeUiSkillDraft("prepare-prompt", "skill", p[2]), decodeOptionalString("prepare-prompt", "backendKind", p[3]), decodeOptionalString("prepare-prompt", "workspace", p[4])] as const,
  }),
  "composer-commands": command<readonly UiComposerCommand[]>()({
    decode: (p) => [decodeString("composer-commands", "backendKind", p[0]), decodeString("composer-commands", "workspace", p[1])] as const,
  }),
  "prompt": command<void>()({ audit: { label: "sent a prompt", thread: 2 }, decode: (p) => promptArgs("prompt", p) }),
  "steer": command<void>()({ audit: { label: "steered a run", thread: 2 }, decode: (p) => promptArgs("steer", p) }),
  "follow-up": command<void>()({ audit: { label: "sent a follow-up", thread: 2 }, decode: (p) => promptArgs("follow-up", p) }),
  "queue-message": command<{ id: string }, [sessionId: string, text: string, attachments: UiPromptAttachment[], skillDraft?: UiSkillDraft | null, deliverAt?: number, identity?: ClientTurnIdentity]>()({
    audit: { label: "queued a message", thread: 0 },
    decode: (p) => {
      const args = [decodeString("queue-message", "sessionId", p[0]), decodeText("queue-message", "text", p[1]), decodeUiPromptAttachments("queue-message", "attachments", p[2]) ?? [], decodeUiSkillDraft("queue-message", "skillDraft", p[3] ?? undefined), decodeDeliverAt("queue-message", p[4])] as const;
      return p[5] == null ? args : [...args, decodeClientTurnIdentity("queue-message", "identity", p[5])] as const;
    },
  }),
  "take-queued": command<UiQueuedPrompt[]>()({ audit: { label: "took a queued message", thread: 0 }, decode: (p) => [decodeString("take-queued", "sessionId", p[0]), decodeOptionalString("take-queued", "id", p[1])] as const }),
  "move-queued": command<void>()({ audit: { label: "reordered queued messages", thread: 0 }, decode: (p) => [decodeString("move-queued", "sessionId", p[0]), decodeString("move-queued", "id", p[1]), decodeIndex("move-queued", p[2])] as const }),
  "plan-queued": command<void, [sessionId: string, id: string, deliverAt?: number | null]>()({ audit: { label: "planned a queued message", thread: 0 }, decode: (p) => [decodeString("plan-queued", "sessionId", p[0]), decodeString("plan-queued", "id", p[1]), decodeDeliverAt("plan-queued", p[2])] as const }),
  "resume-limited": command<void>()({ audit: { label: "resumed a thread after a limit", thread: 0 }, decode: (p) => [decodeString("resume-limited", "sessionId", p[0]), resumeWhen(p[1])] as const }),
  "thread-goal": command<void>()({ audit: { label: "changed a goal", thread: 0 }, decode: (p) => [decodeString("thread-goal", "sessionId", p[0]), goalAction(p[1]), decodeOptionalText("thread-goal", "objective", p[2])] as const }),
  "thread-background-stop": command<void>()({ audit: { label: "stopped background work", thread: 0 }, decode: (p) => [decodeString("thread-background-stop", "sessionId", p[0]), decodeOptionalString("thread-background-stop", "taskId", p[1])] as const }),
  "abort": command<void>()({ audit: { label: "stopped a run", thread: 0 }, decode: (p) => [decodeOptionalString("abort", "sessionId", p[0])] as const }),
  "new-session": command<NewThreadResult>()({
    audit: { label: "started a thread" },
    decode: (p) => [decodeOptionalText("new-session", "initialPrompt", p[0]), decodeUiPromptAttachments("new-session", "attachments", p[1]), decodeOptionalString("new-session", "cwd", p[2]), decodeStringOrClientTurnIdentity("new-session", "clientMessageIdOrRequestId", p[3]), decodePreparedPrompt("new-session", "prepared", p[4]), decodeNewThreadConfiguration("new-session", "configuration", p[5])] as const,
  }),
  "start-thread": command<{ sessionId: string; cwd: string; title?: string; path: string }>()({ audit: { label: "started a thread" }, decode: (p) => [decodeThreadStartOptions("start-thread", p[0])] as const }),
  "send-to-thread": command<null, [sessionId: string, text: string, delivery?: ReturnType<typeof decodeThreadDelivery>, identity?: ReturnType<typeof decodeStringOrClientTurnIdentity>]>()({ audit: { label: "sent a message to a thread", thread: 0 }, decode: (p) => [decodeString("send-to-thread", "sessionId", p[0]), decodeString("send-to-thread", "text", p[1]), decodeThreadDelivery("send-to-thread", p[2]), decodeStringOrClientTurnIdentity("send-to-thread", "identity", p[3])] as const }),
  "prepared-thread-capability": command<PreparedThreadCapability>()({ decode: (p) => [decodeOptionalString("prepared-thread-capability", "cwd", p[0])] as const }),
  "run-shell-action": command<ShellActionResult>()({ audit: { label: "ran a shell command" }, decode: (p) => [decodeString("run-shell-action", "command", p[0]), decodeOptionalBoolean("run-shell-action", "includeInContext", p[1]), decodeOptionalString("run-shell-action", "expectedCwd", p[2])] as const }),
  "compact-and-send": command<HostActionResult>()({ audit: { label: "compacted the context and queued a message" }, decode: (p) => {
    const sessionId = decodeString("compact-and-send", "sessionId", p[0]);
    const prompt = decodeCompactionPrompt(p[1]);
    if (!prompt) throw new Error("compact-and-send: prompt is required");
    return [sessionId, prompt] as const;
  } }),
});
