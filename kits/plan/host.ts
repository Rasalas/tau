import type { HostExtension } from "tau/host-extension";
import { createPlanModeExtension } from "./pi-extension.js";
import { PLAN_HOST_EXTENSION_ID, PLAN_MODE } from "./protocol.js";

interface NewThreadInput {
  cwd: string;
  prompt: string;
  title?: string;
  backend?: string;
  model?: { provider: string; id: string };
}

function newThreadInput(input: unknown): NewThreadInput {
  const fields = input && typeof input === "object" ? input as Record<string, unknown> : {};
  if (typeof fields.cwd !== "string" || !fields.cwd) throw new Error('implement-in-new-thread needs "cwd".');
  if (typeof fields.prompt !== "string" || !fields.prompt.trim()) throw new Error('implement-in-new-thread needs "prompt".');
  const model = fields.model as { provider?: unknown; id?: unknown } | undefined;
  return {
    cwd: fields.cwd,
    prompt: fields.prompt,
    ...(typeof fields.title === "string" && fields.title ? { title: fields.title } : {}),
    ...(typeof fields.backend === "string" && fields.backend ? { backend: fields.backend } : {}),
    ...(model && typeof model.provider === "string" && typeof model.id === "string" ? { model: { provider: model.provider, id: model.id } } : {}),
  };
}

/**
 * Plan Kit's host half: gives Pi threads the `plan` mode through a runtime
 * extension, and starts the thread "Implement in a new thread" hands a plan to.
 */
export function createPlanHostExtension(): HostExtension {
  return {
    id: PLAN_HOST_EXTENSION_ID,
    name: "Plan Kit",
    activate(context) {
      const releaseRuntime = context.services.registerRuntimeExtension("tau-plan", createPlanModeExtension(), { modes: [PLAN_MODE] });
      const releaseCommand = context.registerCommand("implement-in-new-thread", async (input) => {
        const { sessionId } = await context.services.sessions.start(newThreadInput(input));
        return { sessionId };
      });
      return () => { releaseCommand(); releaseRuntime(); };
    },
  };
}

export default createPlanHostExtension;
