import { describe, expect, it } from "vitest";
import { ALLOW, ALLOW_SESSION, DENY, approvalDialog, policyForLevel, refusal } from "./approvals.js";

describe("policyForLevel", () => {
  it("maps Tau's access levels onto Codex's approval policy and sandbox", () => {
    expect(policyForLevel("read-only")).toEqual({ approvalPolicy: "never", sandbox: "read-only", sandboxPolicy: { type: "readOnly" } });
    expect(policyForLevel("ask")).toEqual({ approvalPolicy: "untrusted", sandbox: "workspace-write", sandboxPolicy: { type: "workspaceWrite" } });
    expect(policyForLevel("full")).toEqual({ approvalPolicy: "never", sandbox: "danger-full-access", sandboxPolicy: { type: "dangerFullAccess" } });
  });
});

describe("approvalDialog", () => {
  const command = { kind: "command", threadId: "t", turnId: "u", itemId: "exec-1", command: "/bin/zsh -lc 'echo tau-ok > out.txt && cat out.txt'", cwd: "/repo" };

  it("asks about a command with the shell wrapper removed and answers in Codex's words", () => {
    const dialog = approvalDialog("item/commandExecution/requestApproval", command)!;
    expect(dialog.prompts).toEqual([{ kind: "select", title: "Codex wants to run a command", message: "echo tau-ok > out.txt && cat out.txt\nin /repo", options: [ALLOW, ALLOW_SESSION, DENY] }]);
    expect(dialog.resultFor([{ value: ALLOW }])).toEqual({ decision: "accept" });
    expect(dialog.resultFor([{ value: ALLOW_SESSION }])).toEqual({ decision: "acceptForSession" });
    expect(dialog.resultFor([{ value: DENY }])).toEqual({ decision: "decline" });
    expect(dialog.resultFor([{ value: "not like that", typed: true }])).toEqual({ decision: "decline" });
    // An aborted thread answers the dialog as cancelled; Codex then stops the turn.
    expect(dialog.resultFor([{ cancelled: true }])).toEqual({ decision: "cancel" });
    expect(dialog.resultFor([])).toEqual({ decision: "cancel" });
  });

  it("names the file a change would write, from the item Codex announced before asking", () => {
    const dialog = approvalDialog("item/fileChange/requestApproval", { threadId: "t", turnId: "u", itemId: "exec-2", reason: null, grantRoot: null }, (itemId) => itemId === "exec-2" ? ["/repo/note.txt"] : [])!;
    expect(dialog.prompts[0]).toMatchObject({ title: "Codex wants to edit /repo/note.txt", options: [ALLOW, ALLOW_SESSION, DENY] });
    expect(dialog.resultFor([{ confirmed: true }])).toEqual({ decision: "accept" });
  });

  it("grants requested permissions for the turn or the session, and nothing on deny", () => {
    const params = { permissions: { network: { enabled: true }, fileSystem: null }, reason: "fetch a page" };
    const dialog = approvalDialog("item/permissions/requestApproval", params)!;
    expect(dialog.resultFor([{ value: ALLOW }])).toEqual({ permissions: { network: { enabled: true } }, scope: "turn" });
    expect(dialog.resultFor([{ value: ALLOW_SESSION }])).toEqual({ permissions: { network: { enabled: true } }, scope: "session" });
    expect(dialog.resultFor([{ value: DENY }])).toEqual({ permissions: {}, scope: "turn" });
  });

  it("asks Codex's questions one at a time and returns the answers by question id", () => {
    const dialog = approvalDialog("item/tool/requestUserInput", {
      questions: [
        { id: "color", header: "Color", question: "Which color?", isOther: false, isSecret: false, options: [{ label: "Red", description: "" }, { label: "Blue", description: "" }] },
        { id: "name", header: "Name", question: "What name?", isOther: true, isSecret: false, options: null },
      ],
    })!;
    expect(dialog.prompts).toEqual([{ kind: "select", title: "Which color?", options: ["Red", "Blue"] }, { kind: "input", title: "What name?" }]);
    expect(dialog.resultFor([{ value: "Blue" }, { value: "tau" }])).toEqual({ answers: { color: { answers: ["Blue"] }, name: { answers: ["tau"] } } });
    expect(dialog.resultFor([{ cancelled: true }])).toEqual({ answers: {} });
  });

  it("answers the legacy approval methods in their own words", () => {
    const dialog = approvalDialog("execCommandApproval", { command: ["ls", "-la"], reason: null })!;
    expect(dialog.resultFor([{ value: ALLOW }])).toEqual({ decision: "approved" });
    expect(dialog.resultFor([{ value: DENY }])).toEqual({ decision: { denied: { rejection: "The user declined." } } });
    expect(dialog.resultFor([{ cancelled: true }])).toEqual({ decision: "abort" });
  });

  it("offers a yes/no elicitation and declines one that wants a form filled", () => {
    const plain = approvalDialog("mcpServer/elicitation/request", { serverName: "linear", mode: "form", message: "Allow access?", requestedSchema: { type: "object", properties: {} } })!;
    expect(plain.resultFor([{ value: ALLOW }])).toMatchObject({ action: "accept" });
    expect(approvalDialog("mcpServer/elicitation/request", { mode: "form", requestedSchema: { properties: { name: {} } } })).toBeUndefined();
    expect(refusal("mcpServer/elicitation/request")).toEqual({ action: "decline", content: null, _meta: null });
    expect(approvalDialog("item/tool/call", {})).toBeUndefined();
    expect(refusal("item/tool/call")).toBeUndefined();
  });
});
