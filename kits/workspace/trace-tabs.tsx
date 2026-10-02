import { useEffect, useRef } from "react";
import { useWorkbench } from "tau";

/**
 * Trace tabs (design 1a): a file the agent reads or edits joins an open stage
 * as one italic tab behind the one in front. Only calls that arrive while the
 * thread is on screen count, not the turn found on opening it.
 */
export function TraceTabs({ enabled }: { enabled(): boolean }) {
  const { tools, registry, openFile, snapshot } = useWorkbench();
  const seen = useRef<{ thread?: string | undefined; ids: Set<string> }>({ ids: new Set() });
  const thread = snapshot?.sessionId;
  useEffect(() => {
    if (seen.current.thread !== thread) {
      seen.current = { thread, ids: new Set(tools.map((tool) => tool.id)) };
      return;
    }
    for (const tool of tools) {
      if (seen.current.ids.has(tool.id)) continue;
      seen.current.ids.add(tool.id);
      const file = registry.presentTool(tool).file;
      if (file && enabled()) openFile(file, { trace: true });
    }
  }, [openFile, registry, thread, tools]);
  return null;
}
