import type { UiMessage, UiToolRun } from "../shared/contracts";
import type { ExtensionRegistry, TranscriptRow, WorkbenchActions } from "./extension-system";

/** Cards own their extra rows; core lends the loaded transcript and places their anchors. */
export function toolCardTranscriptRows(tools: readonly UiToolRun[], messages: readonly UiMessage[], registry: ExtensionRegistry, actions?: WorkbenchActions): TranscriptRow[] {
  if (!actions) return [];
  const batches = new Map<string, UiToolRun[]>();
  for (const tool of new Map(tools.map((entry) => [entry.id, entry])).values()) {
    const card = registry.toolCardFor(tool);
    if (!card?.transcriptRows) continue;
    const batch = batches.get(card.id) ?? [];
    batch.push(tool);
    batches.set(card.id, batch);
  }
  return [...batches].flatMap(([id, batch]) => {
    const card = registry.toolCard(id);
    try { return card?.transcriptRows?.({ tools: batch, messages, actions }) ?? []; }
    catch (error) {
      console.error(`Tool card ${id} transcript rows failed`, error);
      return [];
    }
  });
}
