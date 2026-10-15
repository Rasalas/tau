import type { PreparedPrompt, PreparedThreadCapability, UiQueuedPrompt, ShellActionResult, UiComposerCommand } from "./contracts.js";
import type { HostActionResult, NewThreadResult } from "./host-protocol.js";
import { command } from "./host-command-definition.js";
import {
  decodeString, decodeText, decodeOptionalString, decodeOptionalText, decodeOptionalBoolean,
  decodeUiPromptAttachments, decodeUiSkillDraft, decodeStringOrClientTurnIdentity,
  decodePreparedPrompt, decodeNewThreadConfiguration, decodeThreadStartOptions,
  decodeThreadDelivery, decodeCompactionPrompt,
} from "./host-command-input.js";

function promptArgs(method: string, params: readonly unknown[]) {
  return [decodeText(method, "text", params[0]), decodeUiPromptAttachments(method, "attachments", params[1]), decodeOptionalString(method, "sessionId", params[2]), decodeStringOrClientTurnIdentity(method, "clientMessageIdOrIdentity", params[3]), decodePreparedPrompt(method, "prepared", params[4])] as const;
}
function decodeIndex(method: string, value: unknown) {
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`${method}: toIndex must be an integer.`);
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

export const HOST_TURN_COMMANDS = {
  "prepare-prompt": command<PreparedPrompt | undefined>()({
    access: "write", audit: { label: "prepared a prompt", thread: 1, automatic: true },
    decode: (p) => [decodeText("prepare-prompt", "text", p[0]), decodeOptionalString("prepare-prompt", "sessionId", p[1]), decodeUiSkillDraft("prepare-prompt", "skill", p[2]), decodeOptionalString("prepare-prompt", "backendKind", p[3]), decodeOptionalString("prepare-prompt", "workspace", p[4])] as const,
  }),
  "composer-commands": command<readonly UiComposerCommand[]>()({
    access: "read",
    decode: (p) => [decodeString("composer-commands", "backendKind", p[0]), decodeString("composer-commands", "workspace", p[1])] as const,
  }),
  "prompt": command<void>()({ access: "write", job: true, audit: { label: "sent a prompt", thread: 2 }, decode: (p) => promptArgs("prompt", p) }),
  "steer": command<void>()({ access: "write", job: true, audit: { label: "steered a run", thread: 2 }, decode: (p) => promptArgs("steer", p) }),
  "follow-up": command<void>()({ access: "write", job: true, audit: { label: "sent a follow-up", thread: 2 }, decode: (p) => promptArgs("follow-up", p) }),
  "queue-message": command<{ id: string }>()({
    access: "write", audit: { label: "queued a message", thread: 0 },
    decode: (p) => [decodeString("queue-message", "sessionId", p[0]), decodeText("queue-message", "text", p[1]), decodeUiPromptAttachments("queue-message", "attachments", p[2]) ?? [], decodeUiSkillDraft("queue-message", "skillDraft", p[3])] as const,
  }),
  "take-queued": command<UiQueuedPrompt[]>()({ access: "write", audit: { label: "took a queued message", thread: 0 }, decode: (p) => [decodeString("take-queued", "sessionId", p[0]), decodeOptionalString("take-queued", "id", p[1])] as const }),
  "move-queued": command<void>()({ access: "write", audit: { label: "reordered queued messages", thread: 0 }, decode: (p) => [decodeString("move-queued", "sessionId", p[0]), decodeString("move-queued", "id", p[1]), decodeIndex("move-queued", p[2])] as const }),
  "resume-limited": command<void>()({ access: "write", audit: { label: "resumed a thread after a limit", thread: 0 }, decode: (p) => [decodeString("resume-limited", "sessionId", p[0]), resumeWhen(p[1])] as const }),
  "thread-goal": command<void>()({ access: "write", audit: { label: "changed a goal", thread: 0 }, decode: (p) => [decodeString("thread-goal", "sessionId", p[0]), goalAction(p[1]), decodeOptionalText("thread-goal", "objective", p[2])] as const }),
  "thread-background-stop": command<void>()({ access: "write", audit: { label: "stopped background work", thread: 0 }, decode: (p) => [decodeString("thread-background-stop", "sessionId", p[0]), decodeOptionalString("thread-background-stop", "taskId", p[1])] as const }),
  "abort": command<void>()({ access: "write", audit: { label: "stopped a run", thread: 0 }, decode: (p) => [decodeOptionalString("abort", "sessionId", p[0])] as const }),
  "new-session": command<NewThreadResult>()({
    access: "write", job: true, audit: { label: "started a thread" },
    decode: (p) => [decodeOptionalText("new-session", "initialPrompt", p[0]), decodeUiPromptAttachments("new-session", "attachments", p[1]), decodeOptionalString("new-session", "cwd", p[2]), decodeStringOrClientTurnIdentity("new-session", "clientMessageIdOrRequestId", p[3]), decodePreparedPrompt("new-session", "prepared", p[4]), decodeNewThreadConfiguration("new-session", "configuration", p[5])] as const,
  }),
  "start-thread": command<{ sessionId: string; cwd: string; title?: string; path: string }>()({ access: "write", audit: { label: "started a thread" }, decode: (p) => [decodeThreadStartOptions("start-thread", p[0])] as const }),
  "send-to-thread": command<null, [sessionId: string, text: string, delivery?: ReturnType<typeof decodeThreadDelivery>]>()({ access: "write", audit: { label: "sent a message to a thread", thread: 0 }, decode: (p) => [decodeString("send-to-thread", "sessionId", p[0]), decodeString("send-to-thread", "text", p[1]), decodeThreadDelivery("send-to-thread", p[2])] as const }),
  "prepared-thread-capability": command<PreparedThreadCapability>()({ access: "read", decode: (p) => [decodeOptionalString("prepared-thread-capability", "cwd", p[0])] as const }),
  "run-shell-action": command<ShellActionResult>()({ access: "write", audit: { label: "ran a shell command" }, decode: (p) => [decodeString("run-shell-action", "command", p[0]), decodeOptionalBoolean("run-shell-action", "includeInContext", p[1]), decodeOptionalString("run-shell-action", "expectedCwd", p[2])] as const }),
  "compact-and-send": command<HostActionResult>()({ access: "write", audit: { label: "compacted the context and queued a message" }, decode: (p) => {
    const sessionId = decodeString("compact-and-send", "sessionId", p[0]);
    const prompt = decodeCompactionPrompt(p[1]);
    if (!prompt) throw new Error("compact-and-send: prompt is required");
    return [sessionId, prompt] as const;
  } }),
};
