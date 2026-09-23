import { describe, expect, it } from "vitest";
import {
  formatEnvironment,
  instanceIdFromName,
  instanceIdProblem,
  isRuntimeInstanceOf,
  parseEnvironment,
  runtimeDriver,
  runtimeInstanceId,
  runtimeInstanceKind,
  splitArguments,
} from "./runtime-instances.js";

describe("runtime instances", () => {
  it("keeps the program's kind for the default instance and names the others after it", () => {
    expect(runtimeInstanceKind("codex", "default")).toBe("codex");
    expect(runtimeInstanceKind("codex", "work")).toBe("codex@work");
    expect(runtimeDriver("codex@work")).toBe("codex");
    expect(runtimeDriver("claude-code")).toBe("claude-code");
    expect(runtimeInstanceId("codex@work")).toBe("work");
    expect(runtimeInstanceId("codex")).toBe("default");
    expect(isRuntimeInstanceOf("codex@work", "codex")).toBe(true);
    expect(isRuntimeInstanceOf("codex-fork", "codex")).toBe(false);
    expect(isRuntimeInstanceOf(undefined, "codex")).toBe(false);
  });

  it("derives an id from a name and says why one cannot be taken", () => {
    expect(instanceIdFromName("  Work account ")).toBe("work-account");
    expect(instanceIdFromName("2nd")).toBe("i-2nd");
    expect(instanceIdFromName("!!!")).toBe("");
    expect(instanceIdProblem("", [])).toBe("Give the instance a name.");
    expect(instanceIdProblem("default", [])).toContain("Tau starts with");
    expect(instanceIdProblem("Work", [])).toContain("starts with a letter");
    expect(instanceIdProblem("work", ["work"])).toContain("exists already");
    expect(instanceIdProblem("work", ["home"])).toBeUndefined();
  });

  it("reads NAME=value lines and writes them back", () => {
    expect(parseEnvironment("# comment\nA=1\n\n B = two words \nEMPTY=")).toEqual({ env: { A: "1", B: "two words", EMPTY: "" } });
    expect(parseEnvironment("A=1\n2B=x").problem).toBe("Line 2 is not NAME=value.");
    expect(parseEnvironment("JUSTNAME").problem).toBe("Line 1 is not NAME=value.");
    expect(formatEnvironment({ A: "1", B: "2" })).toBe("A=1\nB=2");
  });

  it("splits arguments like a shell, quotes and escapes included, without expanding anything", () => {
    expect(splitArguments(`-c model="gpt 5" --flag 'a b' x\\ y "" $HOME`)).toEqual(["-c", "model=gpt 5", "--flag", "a b", "x y", "", "$HOME"]);
    expect(splitArguments(undefined)).toEqual([]);
    expect(splitArguments("   ")).toEqual([]);
  });
});
