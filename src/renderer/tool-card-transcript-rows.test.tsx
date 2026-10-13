import { expect, it, vi } from "vitest";
import type { UiToolRun } from "../shared/contracts";
import { ExtensionRegistry, type WorkbenchActions } from "./extension-system";
import { toolCardTranscriptRows } from "./tool-card-transcript-rows";

it("lends each card its latest tools once when saved and live activity overlap", async () => {
  const registry = new ExtensionRegistry();
  const transcriptRows = vi.fn(() => [{ id: "return", afterMessageId: "u", content: "Returned" }]);
  await registry.activate({ id: "test.cards", name: "Cards", activate(context) {
    context.registerToolCard({ id: "cards", match: (tool) => tool.name === "background", Component: () => null, transcriptRows });
  } });
  const earlier: UiToolRun = { id: "child", name: "background", args: {}, status: "running", startedAt: 1 };
  const latest = { ...earlier, status: "done" as const, endedAt: 2 };
  const regular = { ...earlier, id: "read", name: "read" };
  const messages = [{ id: "u", role: "user" as const, text: "Inspect", timestamp: 0 }];
  const actions = {} as WorkbenchActions;
  expect(toolCardTranscriptRows([earlier, regular, latest], messages, registry, actions).map((row) => row.id)).toEqual(["return"]);
  expect(transcriptRows).toHaveBeenCalledExactlyOnceWith({ tools: [latest], messages, actions });
  registry.deactivate("test.cards");
  expect(toolCardTranscriptRows([latest], messages, registry, actions)).toEqual([]);
});
