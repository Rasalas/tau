import type { WorkbenchActions } from "tau";
import type { AgentRow } from "./model.js";
import { agentsHost } from "./store.js";

/**
 * Stops the agent behind a row and the agents below it. A runtime's own child
 * stops through its task; a Tau thread through the kit's `stop-agent`.
 */
export async function stopAgent(row: AgentRow, actions: Pick<WorkbenchActions, "notify" | "stopBackground">): Promise<void> {
  try {
    if (row.native) {
      if (!row.taskId || !actions.stopBackground) throw new Error(`${row.title} cannot be stopped from here.`);
      await actions.stopBackground(row.taskId);
    } else {
      await agentsHost.invoke?.("stop-agent", { threadId: row.threadId ?? row.id });
    }
  } catch (error) {
    actions.notify(error instanceof Error ? error.message : String(error), "error");
  }
}
