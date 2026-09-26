import { describe, expect, it } from "vitest";
import type { UiProject, UiSession } from "../shared/contracts";
import { lastUsedProject, rootLast } from "./new-thread-project";

const project = (path: string, lastOpenedAt: number): UiProject => ({ path, name: path.split("/").at(-1) || path, lastOpenedAt });
const thread = (projectPath: string, modifiedAt: number, messageCount = 2): UiSession =>
  ({ id: `${projectPath}-${modifiedAt}`, path: `${projectPath}/${modifiedAt}.jsonl`, title: "", modifiedAt, projectPath, projectName: "", messageCount });

describe("lastUsedProject", () => {
  it("takes the project the host opened last", () => {
    expect(lastUsedProject([project("/a", 1), project("/b", 5)], [])?.path).toBe("/b");
  });

  it("prefers the project whose threads were busy more recently", () => {
    expect(lastUsedProject([project("/a", 1), project("/b", 5)], [thread("/a", 9)])?.path).toBe("/a");
  });

  it("ignores a session nobody wrote in", () => {
    expect(lastUsedProject([project("/a", 1), project("/b", 5)], [thread("/a", 9, 0)])?.path).toBe("/b");
  });

  it("never picks the filesystem root, however recent", () => {
    expect(lastUsedProject([project("/", 99), project("/a", 1)], [thread("/", 100)])?.path).toBe("/a");
  });

  it("asks when there is no project but the root", () => {
    expect(lastUsedProject([project("/", 99)], [])).toBeUndefined();
    expect(lastUsedProject([], [])).toBeUndefined();
  });
});

describe("rootLast", () => {
  it("moves / to the end and keeps the rest in order", () => {
    expect(rootLast([project("/", 9), project("/b", 2), project("/a", 1)]).map((entry) => entry.path)).toEqual(["/b", "/a", "/"]);
  });
});
