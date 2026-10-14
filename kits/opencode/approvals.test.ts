import { describe, expect, it } from "vitest";
import { ALLOW, ALLOW_SESSION, DENY, permissionDialog, questionDialogs, rulesForLevel, rulesForLevelV2, type OpenCode2Rule } from "./approvals.js";
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

  it("shows a command longer than 600 characters in full", () => {
    const command = `printf '%s' '${"two  spaces ".repeat(60)}'\nprintf 'finished'`;
    expect(command.length).toBeGreaterThan(600);
    const dialog = permissionDialog({ id: "per_2", sessionID: "ses_1", permission: "bash", patterns: [command], metadata: { command } });
    expect(dialog.prompt).toMatchObject({ message: command });
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

const r2 = (action: string, effect: OpenCode2Rule["effect"], resource = "*"): OpenCode2Rule => ({ action, resource, effect });
const LOOKING_V2 = ["read", "glob", "grep", "list", "lsp", "skill", "todo", "question"].map((name) => r2(name, "allow"));
const ENV_V2 = [r2("read", "ask", "*.env"), r2("read", "ask", "*.env.*"), r2("read", "allow", "*.env.example")];
const TAU_V2 = r2("tau_*", "allow");
/** Every action a tool of Pi's can need, in the order the rules list them. */
const ALL_DENIED = ["read", "shell", "edit", "grep", "glob", "list", "websearch", "webfetch"].map((name) => r2(name, "deny"));
const without = (...names: string[]) => ALL_DENIED.filter((entry) => !names.includes(entry.action));

describe("Tau's access levels as OpenCode 2's rules", () => {
  it("lets nothing ask at full access, and never asks for Tau's own tools", () => {
    expect(rulesForLevelV2("full")).toEqual([r2("*", "allow"), r2("external_directory", "allow"), TAU_V2]);
  });

  it("asks before anything but looking, with the .env rules after the looking ones", () => {
    expect(rulesForLevelV2("ask")).toEqual([r2("*", "ask"), ...LOOKING_V2, ...ENV_V2, TAU_V2]);
  });

  it("asks at auto the way it does at ask, since OpenCode has no reviewer", () => {
    expect(rulesForLevelV2("auto")).toEqual(rulesForLevelV2("ask"));
  });

  it("denies writing in read-only, and still lets a command, a fetch and a search ask", () => {
    expect(rulesForLevelV2("read-only")).toEqual([
      r2("*", "deny"), ...LOOKING_V2, ...ENV_V2,
      r2("shell", "ask"), r2("webfetch", "ask"), r2("websearch", "ask"), r2("edit", "deny"),
      TAU_V2,
    ]);
  });

  it("names a command `shell`, not `bash`, and never uses OpenCode 1's rule keys", () => {
    for (const level of ["full", "ask", "auto", "read-only"] as const) {
      const rules = rulesForLevelV2(level);
      expect(rules.some((entry) => entry.action === "bash")).toBe(false);
      for (const entry of rules) expect(Object.keys(entry).sort()).toEqual(["action", "effect", "resource"]);
    }
  });

  it("puts Tau's allow last at every level and tools, so nothing after it can deny it", () => {
    for (const level of ["full", "ask", "auto", "read-only"] as const) {
      expect(rulesForLevelV2(level).at(-1)).toEqual(TAU_V2);
      expect(rulesForLevelV2(level, []).at(-1)).toEqual(TAU_V2);
    }
  });

  it("denies the actions of tools a thread lacks, and a sub-agent, after the level's rules", () => {
    expect(rulesForLevelV2("ask", ["read", "bash"])).toEqual([
      r2("*", "ask"), ...LOOKING_V2, ...ENV_V2, ...without("read", "shell"), r2("subagent", "deny"), TAU_V2,
    ]);
    expect(rulesForLevelV2("full", ["read", "bash"])).toEqual([
      r2("*", "allow"), r2("external_directory", "allow"), ...without("read", "shell"), r2("subagent", "deny"), TAU_V2,
    ]);
    const readOnly = rulesForLevelV2("read-only", ["read"]);
    expect(readOnly.slice(-9)).toEqual([...without("read"), r2("subagent", "deny"), TAU_V2]);
    const at = (action: string) => readOnly.findIndex((entry) => entry.action === action && entry.effect === "deny");
    expect(at("edit")).toBeGreaterThan(-1);
    expect(at("edit")).toBeLessThan(at("subagent"));
  });

  it("denies everything for an empty tool list, and nothing extra without a list", () => {
    expect(rulesForLevelV2("ask", [])).toEqual([r2("*", "ask"), ...LOOKING_V2, ...ENV_V2, ...ALL_DENIED, r2("subagent", "deny"), TAU_V2]);
    expect(rulesForLevelV2("ask").some((entry) => entry.effect === "deny")).toBe(false);
    expect(rulesForLevelV2("ask")).not.toContainEqual(r2("subagent", "deny"));
  });

  it("shares one edit action between edit and write", () => {
    for (const tools of [["edit"], ["write"], ["edit", "write"]]) {
      expect(rulesForLevelV2("full", tools)).not.toContainEqual(r2("edit", "deny"));
    }
    expect(rulesForLevelV2("full", ["read"])).toContainEqual(r2("edit", "deny"));
  });

  it("keeps the actions that ls, find and the web tools stand for", () => {
    const denied = (tools: string[]) => rulesForLevelV2("full", tools).filter((entry) => entry.effect === "deny").map((entry) => entry.action);
    expect(denied(["ls"])).not.toContain("list");
    expect(denied(["ls"])).not.toContain("glob");
    expect(denied(["find"])).toContain("list");
    expect(denied(["find"])).not.toContain("glob");
    expect(denied(["web_search"])).not.toContain("websearch");
    expect(denied(["web_search"])).toContain("webfetch");
    expect(denied(["fetch"])).not.toContain("webfetch");
    expect(denied(["fetch"])).toContain("websearch");
  });

  it("ignores a tool it has no action for", () => {
    expect(rulesForLevelV2("full", ["unknown_tool"])).toEqual(rulesForLevelV2("full", []));
  });
});

describe("OpenCode 2's requests on the dialog surface", () => {
  it("asks for a command with its patterns as the detail and the session grant named", () => {
    const dialog = permissionDialog({ id: "per_1", sessionID: "ses_1", permission: "shell", patterns: ["npm test", "npm run lint"], always: ["npm *"] });
    expect(dialog.prompt).toEqual({ kind: "select", title: "OpenCode wants to run a command", message: "npm test\nnpm run lint\nFor this session: npm *", options: [ALLOW, ALLOW_SESSION, DENY] });
    expect(dialog.reply({ value: ALLOW })).toBe("once");
    expect(dialog.reply({ value: ALLOW_SESSION })).toBe("always");
    expect(dialog.reply({ value: DENY })).toBe("reject");
  });

  it("leaves a wildcard out of the message, and the message out when nothing is left", () => {
    const dialog = permissionDialog({ id: "per_2", sessionID: "ses_1", permission: "shell", patterns: ["*"], always: ["*"] });
    expect(dialog.prompt).toEqual({ kind: "select", title: "OpenCode wants to run a command", options: [ALLOW, ALLOW_SESSION, DENY] });
    expect(dialog.prompt).not.toHaveProperty("message");
  });

  it("titles a sub-agent, an edit and an unknown action", () => {
    const title = (permission: string) => permissionDialog({ id: "p", sessionID: "ses_1", permission }).prompt.title;
    expect(title("subagent")).toBe("OpenCode wants to start a sub-agent");
    expect(title("edit")).toBe("OpenCode wants to edit files");
    expect(title("webfetch")).toBe("OpenCode wants to fetch a page");
    expect(title("lsp")).toBe("OpenCode asks for “lsp”");
  });
});
