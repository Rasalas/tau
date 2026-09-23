import { describe, expect, it } from "vitest";
import { inRuntimeOrder } from "./runtime-order";

describe("inRuntimeOrder", () => {
  it("follows the host's list and puts what it does not list last, in the order given", () => {
    const backends = [{ kind: "pi", label: "Pi" }, { kind: "agent-sdk", label: "Agent SDK" }, { kind: "codex", label: "Codex" }, { kind: "antigravity", label: "Antigravity" }];
    const cards = [{ id: "antigravity" }, { id: "extra" }, { id: "codex" }, { id: "agent-sdk" }, { id: "other" }];
    expect(inRuntimeOrder(cards, (card) => card.id, backends).map((card) => card.id)).toEqual(["agent-sdk", "codex", "antigravity", "extra", "other"]);
    expect(inRuntimeOrder(cards, (card) => card.id, undefined)).toEqual(cards);
  });
});
