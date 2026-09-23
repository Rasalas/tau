import { describe, expect, it } from "vitest";
import type { BackendPrompt, ExtensionUiAnswer } from "tau/host-extension";
import { ALLOW, ALLOW_THREAD, DENY, answerElicitation, modeForLevel, permissionDialog } from "./approvals.js";
import { QUESTIONNAIRE_EXTRA } from "./protocol.js";
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

describe("answerElicitation", () => {
  const scripted = (answers: ExtensionUiAnswer[]) => {
    const asked: BackendPrompt[] = [];
    return { asked, ask: async (prompt: BackendPrompt) => { asked.push(prompt); return answers.shift() ?? { cancelled: true }; } };
  };

  it("asks a form field by field, paged together, and answers with the values", async () => {
    const { asked, ask } = scripted([{ value: "Beta" }, { value: "3" }]);
    const answer = await answerElicitation({ mode: "form", message: "Pick", requestedSchema: { properties: { flavour: { type: "string", enum: ["a", "b"], enumNames: ["Alpha", "Beta"] }, count: { type: "number" } }, required: ["flavour"] } }, ask);
    expect(answer).toEqual({ action: "accept", content: { flavour: "b", count: 3 } });
    expect(asked[0]).toMatchObject({ kind: "select", title: "flavour", message: "Pick", options: ["Alpha", "Beta"] });
    expect(asked[1]!.extras?.[QUESTIONNAIRE_EXTRA]).toMatchObject({ index: 1, questions: [{ header: "Antigravity", options: [{ label: "Alpha" }, { label: "Beta" }] }, { question: "count (optional)", options: [] }] });
  });

  it("asks a form without fields as Allow or Deny, and declines without anyone to ask", async () => {
    const empty = { mode: "form", message: "Go on?", requestedSchema: { type: "object", properties: {} } };
    expect(await answerElicitation(empty, scripted([{ value: ALLOW }]).ask)).toEqual({ action: "accept", content: {} });
    expect(await answerElicitation(empty, scripted([{ value: DENY }]).ask)).toEqual({ action: "decline" });
    expect(await answerElicitation(empty, scripted([{ cancelled: true }]).ask)).toEqual({ action: "cancel" });
    expect(await answerElicitation(empty, undefined)).toEqual({ action: "decline" });
    expect(await answerElicitation({ mode: "form", requestedSchema: { properties: { blob: { type: "object" } } } }, scripted([]).ask)).toEqual({ action: "decline" });
  });
});
