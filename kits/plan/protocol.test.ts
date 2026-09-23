import { describe, expect, it } from "vitest";
import type { UiMessage } from "tau";
import { implementationPrompt, pendingPlan, planBody, planOf, planTitle } from "./protocol.js";

const message = (id: string, role: UiMessage["role"], text: string): UiMessage => ({ id, role, text, timestamp: 0 });
const reply = "Looked around.\n\n<proposed_plan>\n# Add a login form\n\n1. Form\n2. Tests\n</proposed_plan>\n";

describe("Plan Kit protocol", () => {
  it("reads the plan, its title and its body", () => {
    const plan = planOf(reply)!;
    expect(plan).toBe("# Add a login form\n\n1. Form\n2. Tests");
    expect(planTitle(plan)).toBe("Add a login form");
    expect(planBody(plan)).toBe("1. Form\n2. Tests");
    expect(planTitle("1. no heading")).toBeUndefined();
    expect(planOf("<proposed_plan>\n# half")).toBeUndefined();
    expect(implementationPrompt(` ${plan} `)).toBe(`PLEASE IMPLEMENT THIS PLAN:\n${plan}`);
  });

  it("offers the plan of the reply to the last prompt only", () => {
    expect(pendingPlan([message("u1", "user", "plan it"), message("a1", "assistant", reply)])).toEqual({ plan: planOf(reply), messageId: "a1" });
    expect(pendingPlan([message("a1", "assistant", reply), message("u2", "user", "go on")])).toBeUndefined();
    expect(pendingPlan([message("a1", "assistant", reply), message("n", "notice", "compacted"), message("a2", "assistant", "Anything else?")]))
      .toEqual({ plan: planOf(reply), messageId: "a1" });
  });
});
