import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LiveBashOutput, taskOutputRoot } from "./bash-output-tail.js";

const SESSION = "123e4567-e89b-42d3-a456-426614174000";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const bashCall = (id: string, parent: string | null = null) => ({ type: "assistant", parent_tool_use_id: parent, message: { content: [{ type: "tool_use", id, name: "Bash", input: { command: "make" } }] } });
const started = (extra: Record<string, unknown> = {}) => ({ type: "system", subtype: "task_started", session_id: SESSION, task_id: "t1", tool_use_id: "call-1", task_type: "local_bash", is_backgrounded: false, ...extra });
const finished = (id: string) => ({ type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: id, content: "done" }] } });

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "tau-task-output-"));
  roots.push(root);
  const directory = join(root, "project-a", SESSION, "tasks");
  await mkdir(directory, { recursive: true });
  const seen: Array<[string, string]> = [];
  const tail = new LiveBashOutput({ root, pollMs: 10, onOutput: (id, output) => seen.push([id, output]) });
  return { file: join(directory, "t1.output"), seen, tail };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 80));

describe("LiveBashOutput", () => {
  it("reports what a foreground command has written so far, whole, until its result arrives", async () => {
    const { file, seen, tail } = await setup();
    await writeFile(file, "one\n");
    tail.push(bashCall("call-1"));
    tail.push(started());
    await expect.poll(() => seen.at(-1)).toEqual(["call-1", "one\n"]);
    await appendFile(file, "two\n");
    await expect.poll(() => seen.at(-1)).toEqual(["call-1", "one\ntwo\n"]);
    tail.push(finished("call-1"));
    const count = seen.length;
    await appendFile(file, "late\n");
    await settle();
    expect(seen.length).toBe(count);
  });

  it("finds the file when the command creates it later, and keeps a split character whole", async () => {
    const { file, seen, tail } = await setup();
    tail.push(bashCall("call-1"));
    tail.push(started());
    await settle();
    const bytes = Buffer.from("é\n");
    await writeFile(file, bytes.subarray(0, 1));
    await settle();
    await appendFile(file, bytes.subarray(1));
    await expect.poll(() => seen.at(-1)?.[1]).toBe("é\n");
    tail.stop();
  });

  it("leaves background tasks, other tools and a sub-agent's calls alone", async () => {
    const { file, seen, tail } = await setup();
    await writeFile(file, "x\n");
    tail.push(bashCall("call-1"));
    tail.push(started({ is_backgrounded: true }));
    tail.push(started({ tool_use_id: "other" }));
    tail.push(bashCall("call-2", "agent-1"));
    tail.push(started({ tool_use_id: "call-2" }));
    tail.push(started({ task_type: "local_agent" }));
    await settle();
    expect(seen).toEqual([]);
  });

  it("does nothing where the platform has no uid, and roots the CLI's temp folder by uid", () => {
    expect(taskOutputRoot({}, () => undefined)).toBeUndefined();
    expect(taskOutputRoot({ CLAUDE_CODE_TMPDIR: " /var/tmp " }, () => 501)).toBe("/var/tmp/claude-501");
    expect(taskOutputRoot({}, () => 7)).toBe("/tmp/claude-7");
  });
});
