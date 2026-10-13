import { Type } from "typebox";
import type { HostMcpTool } from "./host-extensions.js";
import type { ThreadBackgroundCapability } from "./runtime-types.js";

/** The default requires no model decision; only an independently running service needs a release. */
export const BACKGROUND_WORK_INSTRUCTIONS = "Background work belongs to the current request until its results are handled. Tests, builds, installs, reviews and requested monitoring keep the request open. For an independently running service, first check that it is ready, then use tau_background_tasks to list its task ID and release it. Release only services whose future output is no longer needed to finish the request. Ending your reply does not release background work.";

/** The MCP credential supplies the thread; the caller cannot pick a different thread. */
export function backgroundWorkTool(background: () => ThreadBackgroundCapability | undefined): HostMcpTool {
  return {
    annotations: { readOnlyHint: false },
    name: "tau_background_tasks",
    label: "Background work",
    description: "List this thread's background tasks and unhandled results, read tracked command output, or stop a task when its runtime supports stopping it. Use release only after checking that a command is a ready service which should keep running independently of the completed request. Tests, builds, installs, reviews and monitors must remain required. Releasing does not stop the process or mark the thread done.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("list"), Type.Literal("release"), Type.Literal("read"), Type.Literal("stop")]),
      taskId: Type.Optional(Type.String({ minLength: 1 })),
    }),
    execute: async (_id, input: { action: "list" | "release" | "read" | "stop"; taskId?: string }) => {
      const capability = background();
      if (!capability) throw new Error("This runtime does not report background work.");
      if (input.action === "read") {
        if (!input.taskId || !capability.read) throw new Error("Name a tracked command whose output is available.");
        const result = capability.read(input.taskId);
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      }
      if (input.action === "stop") await capability.stop(input.taskId);
      if (input.action === "release") {
        if (!input.taskId) throw new Error("Name the task ID to release. List background tasks first.");
        if (!capability?.release) throw new Error("This runtime cannot release a background service.");
        capability.release(input.taskId);
      }
      const tasks = (capability?.list?.() ?? capability?.current() ?? []).map((task) => ({ ...task, blocksCompletion: task.blocksCompletion !== false }));
      return { content: [{ type: "text", text: JSON.stringify(tasks) }], details: { tasks } };
    },
  };
}
