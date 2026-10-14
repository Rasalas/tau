import type { UiProject, UiSession } from "../../shared/contracts";
import { threadListOrder } from "../../workbench/thread-supervision";
import type { ThreadActivitySnapshot } from "../../workbench/thread-store";
import type { ThreadRowMark } from "../../workbench/thread-row-status";
import { compactWorkingClock } from "../../workbench/working-clock";

/** The compact list's order for a kit that moves the reader; loaded with the compact layout, never on the desktop. */
export function compactListOrder(threads: readonly UiSession[], activity: ThreadActivitySnapshot, options: {
  pinned: readonly string[];
  marks: Readonly<Record<string, ThreadRowMark>>;
  project?: Pick<UiProject, "path" | "workspaceId">;
  working: boolean;
}): string[] {
  const { working, ...rest } = options;
  return threadListOrder(threads, activity, { ...rest, ...(working ? { working: compactWorkingClock } : {}) });
}
