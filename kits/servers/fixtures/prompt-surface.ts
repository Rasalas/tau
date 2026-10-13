import type { HostCommandCall, HostExtensionCommandHandler, HostExtensionContext } from "tau/host-extension";
import { ServerPrompts, registerServerPromptCommands } from "../prompts.js";
import { SERVERS_PROMPTS_EVENT, type ServerPrompt } from "../protocol.js";
import { TEST_PASSWORD } from "./servers-test-env.mjs";

/** Answers the same published questions and host command as the workbench. */
export function answeringPrompts(context: HostExtensionContext, onQuestion: (prompt: ServerPrompt) => void = () => undefined): ServerPrompts {
  const commands = new Map<string, HostExtensionCommandHandler>();
  const seen = new Set<string>();
  const prompts = new ServerPrompts((event, payload) => {
    context.emit(event, payload);
    if (event !== SERVERS_PROMPTS_EVENT) return;
    for (const prompt of (payload as { prompts: ServerPrompt[] }).prompts) {
      if (seen.has(prompt.id)) continue;
      seen.add(prompt.id);
      onQuestion(prompt);
      queueMicrotask(() => commands.get("answer-prompt")!({
        id: prompt.id, action: "confirm", ...(prompt.kind === "secret" ? { value: TEST_PASSWORD } : {}),
      }, { owner: true } as HostCommandCall));
    }
  }, () => true);
  registerServerPromptCommands({ ...context, registerCommand: (name, handler, options) => {
    commands.set(name, handler);
    return context.registerCommand(name, handler, options);
  } }, prompts);
  return prompts;
}
