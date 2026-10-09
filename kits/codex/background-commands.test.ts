import { describe, expect, it } from "vitest";
import { CodexBackgroundCommands, endedCommandText } from "./background-commands.js";

const item = (status: string, extra: Record<string, unknown> = {}) => ({ item: { type: "commandExecution", id: "c1", command: "/bin/zsh -lc 'npm run dev'", processId: "pty-1", status, ...extra } });

describe("CodexBackgroundCommands", () => {
  it("counts a command only once its turn completed, and forgets one a failed turn left", () => {
    const commands = new CodexBackgroundCommands(() => 3);
    commands.push("item/started", item("inProgress"));
    expect(commands.current()).toEqual([]);
    expect(commands.turnCompleted()).toBe(true);
    expect(commands.current()).toEqual([{ id: "c1", kind: "command", label: "npm run dev", startedAt: 3 }]);
    commands.push("item/started", item("inProgress", { id: "c2" }));
    commands.dropForeground();
    expect(commands.turnCompleted()).toBe(false);
  });

  it("reports an end in the background, but not one the user stopped", () => {
    const commands = new CodexBackgroundCommands(() => 3);
    commands.push("item/started", item("inProgress"));
    commands.turnCompleted();
    commands.stopping("c1", true);
    expect(commands.push("item/completed", item("failed", { exitCode: 143 }))).toEqual({ changed: true });
    commands.push("item/started", item("inProgress"));
    commands.turnCompleted();
    expect(commands.push("item/completed", item("completed", { exitCode: 0, aggregatedOutput: "ready\n" }))).toEqual({ changed: true, ended: { label: "npm run dev", exitCode: 0, output: "ready" } });
  });
});

describe("endedCommandText", () => {
  it("names the command, its exit and the tail of its output", () => {
    const output = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join("\n");
    const text = endedCommandText({ label: "gh run watch 42", exitCode: 1, output });
    expect(text.startsWith("The background command `gh run watch 42` ended with exit code 1.\n\nLast output:\nline 11\n")).toBe(true);
    expect(text.endsWith("line 30")).toBe(true);
    expect(endedCommandText({ label: "x" })).toBe("The background command `x` ended.");
  });
});
