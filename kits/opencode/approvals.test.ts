import { describe, expect, it } from "vitest";
import { ALLOW, ALLOW_SESSION, DENY, permissionDialog, questionDialogs, rulesForLevel } from "./approvals.js";
import { QUESTIONNAIRE_EXTRA } from "./protocol.js";

describe("Tau's access levels as OpenCode's rules", () => {
  it("lets nothing ask at full access, and never asks for Tau's own tools", () => {
    expect(rulesForLevel("full")).toEqual([
      { permission: "*", pattern: "*", action: "allow" },
      { permission: "external_directory", pattern: "*", action: "allow" },
      { permission: "tau_*", pattern: "*", action: "allow" },
    ]);
  });

  it("asks before anything but looking, and before reading .env files", () => {
    const rules = rulesForLevel("ask");
    expect(rules[0]).toEqual({ permission: "*", pattern: "*", action: "ask" });
    expect(rules).toContainEqual({ permission: "read", pattern: "*", action: "allow" });
    expect(rules).toContainEqual({ permission: "read", pattern: "*.env", action: "ask" });
    expect(rules.at(-1)).toEqual({ permission: "tau_*", pattern: "*", action: "allow" });
  });

  it("writes nothing in read-only, and still lets a command ask", () => {
    const rules = rulesForLevel("read-only");
    expect(rules[0]).toEqual({ permission: "*", pattern: "*", action: "deny" });
    expect(rules).toContainEqual({ permission: "edit", pattern: "*", action: "deny" });
    expect(rules).toContainEqual({ permission: "bash", pattern: "*", action: "ask" });
  });
});

describe("OpenCode's requests on the dialog surface", () => {
  it("asks for a command with its text and answers once, always or reject", () => {
    const dialog = permissionDialog({ id: "per_1", sessionID: "ses_1", permission: "bash", patterns: ["echo hi"], metadata: { command: "echo hi" }, always: ["echo *"] });
    expect(dialog.prompt).toEqual({ kind: "select", title: "OpenCode wants to run a command", message: "echo hi\nFor this session: echo *", options: [ALLOW, ALLOW_SESSION, DENY] });
    expect(dialog.reply({ value: ALLOW })).toBe("once");
    expect(dialog.reply({ value: ALLOW_SESSION })).toBe("always");
    expect(dialog.reply({ value: DENY })).toBe("reject");
    expect(dialog.reply({ cancelled: true })).toBe("reject");
    expect(dialog.reply({ value: ALLOW, typed: true })).toBe("reject");
  });

  it("pages several questions and answers each with labels or typed text", () => {
    const dialogs = questionDialogs([
      { question: "Which database?", header: "DB", options: [{ label: "Postgres", description: "" }, { label: "SQLite", description: "" }] },
      { question: "Which targets?", header: "Targets", multiple: true, options: [{ label: "web", description: "" }, { label: "ios", description: "" }, { label: "android", description: "" }] },
      { question: "Anything else?", header: "", options: [] },
    ]);
    expect(dialogs.prompts[0]).toMatchObject({ kind: "select", title: "[DB] Which database?", options: ["Postgres", "SQLite"] });
    expect(dialogs.prompts[1]).toMatchObject({ kind: "input", title: "[Targets] Which targets?" });
    expect((dialogs.prompts[1]!.extras![QUESTIONNAIRE_EXTRA] as { index: number }).index).toBe(1);
    expect(dialogs.answers([{ value: "SQLite" }, { value: "1,3" }, { value: "no", typed: true }])).toEqual([["SQLite"], ["web", "android"], ["no"]]);
    expect(dialogs.answers([{ value: "SQLite" }, { cancelled: true }])).toBeUndefined();
  });
});
