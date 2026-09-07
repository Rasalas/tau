import { describe, expect, it } from "vitest";
import { ALLOW, ALLOW_THREAD, DENY, modeForLevel, permissionDialog } from "./approvals.js";
import type { AcpPermissionRequest } from "./acp-session.js";

const approval: AcpPermissionRequest = {
  sessionId: "s",
  options: [
    { optionId: "o1", name: "Allow once", kind: "allow_once" },
    { optionId: "o2", name: "Allow always", kind: "allow_always", _meta: { "agy.security.warning": { message: "Shell output may carry instructions." } } },
    { optionId: "o3", name: "Reject", kind: "reject_once" },
  ],
  toolCall: { toolCallId: "call-1", title: "Run `npm test`", kind: "execute", rawInput: { CommandLine: "npm test", Cwd: "/repo" } },
};

describe("Antigravity approvals", () => {
  it("offers Allow, Allow for this thread and Deny with the command and the agent's warning", () => {
    const dialog = permissionDialog(approval)!;
    expect(dialog.prompt).toEqual({ kind: "select", title: "Run `npm test`", message: "npm test\nAntigravity warns: Shell output may carry instructions.", options: [ALLOW, ALLOW_THREAD, DENY] });
    expect(dialog.answerFor({ value: ALLOW })).toEqual({ outcome: { outcome: "selected", optionId: "o1" } });
    expect(dialog.answerFor({ value: ALLOW_THREAD })).toEqual({ outcome: { outcome: "selected", optionId: "o2" } });
    expect(dialog.answerFor({ value: DENY })).toEqual({ outcome: { outcome: "selected", optionId: "o3" } });
    expect(dialog.answerFor({ value: "no thanks", typed: true })).toEqual({ outcome: { outcome: "selected", optionId: "o3" } });
    expect(dialog.answerFor({ confirmed: true })).toEqual({ outcome: { outcome: "selected", optionId: "o1" } });
    expect(dialog.answerFor({ cancelled: true })).toEqual({ outcome: { outcome: "cancelled" } });
  });

  it("leaves out choices the agent did not offer", () => {
    const dialog = permissionDialog({ ...approval, options: [approval.options[0]!, approval.options[2]!] })!;
    expect(dialog.prompt.options).toEqual([ALLOW, DENY]);
    expect(dialog.prompt.message).toBe("npm test");
    expect(dialog.answerFor({ value: ALLOW_THREAD })).toEqual({ outcome: { outcome: "cancelled" } });
    expect(permissionDialog({ ...approval, options: [] })).toBeUndefined();
  });

  it("turns a native question into a select whose choices are the agent's own", () => {
    const question: AcpPermissionRequest = {
      sessionId: "s",
      options: [{ optionId: "a", name: "Use TypeScript", kind: "allow_once" }, { optionId: "b", name: "Use JavaScript", kind: "allow_once" }],
      toolCall: { toolCallId: "interaction_7", title: "Which language?" },
    };
    const dialog = permissionDialog(question)!;
    expect(dialog.prompt).toEqual({ kind: "select", title: "Which language?", options: ["Use TypeScript", "Use JavaScript"] });
    expect(dialog.answerFor({ value: "Use JavaScript" })).toEqual({ outcome: { outcome: "selected", optionId: "b" } });
    expect(dialog.answerFor({ value: "Rust", typed: true })).toEqual({ outcome: { outcome: "cancelled" } });
    expect(permissionDialog({ ...question, options: [{ optionId: "a", name: "x", kind: "allow_once" }, { optionId: "a", name: "y", kind: "allow_once" }] })).toBeUndefined();
  });

  it("maps Tau's access levels onto the modes the session offers", () => {
    const modes = [{ value: "default", name: "Default" }, { value: "auto_edit", name: "Auto edit" }, { value: "yolo", name: "Turbo" }];
    expect(modeForLevel("read-only", modes)).toBe("default");
    expect(modeForLevel("read-only", [...modes, { value: "plan", name: "Plan" }])).toBe("plan");
    expect(modeForLevel("ask", modes)).toBe("default");
    expect(modeForLevel("full", modes)).toBe("yolo");
    expect(modeForLevel("full", modes.slice(0, 2))).toBe("auto_edit");
    expect(modeForLevel("full", [])).toBeUndefined();
  });
});
