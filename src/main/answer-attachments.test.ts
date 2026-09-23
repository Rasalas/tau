import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionUiPrompt, ThreadHostEvent } from "../shared/contracts.js";
import { answerImageSaver, answerWithFiles } from "./answer-attachments.js";
import { ExtensionUiCoordinator } from "./extension-ui-coordinator.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "tau-answer-files-test-"));
  directories.push(directory);
  return directory;
}

const png = { kind: "image" as const, name: "../shot.png", mimeType: "image/png", data: Buffer.from("png-bytes").toString("base64"), size: 9 };
const file = { kind: "file" as const, name: "notes.md", mimeType: "text/markdown", path: "/work/notes.md", size: 5 };

describe("answerWithFiles", () => {
  it("writes images into the thread's folder and names every file after the typed answer", async () => {
    const root = await scratch();
    const answer = await answerWithFiles({ value: "see these", typed: true, attachments: [file, png] }, "../thread 1", answerImageSaver(root));
    expect("value" in answer && answer.value.split("\n").slice(0, 4)).toEqual(["see these", "", "Attached files:", "- /work/notes.md"]);
    const image = "value" in answer ? answer.value.split("\n")[4]!.slice(2) : "";
    expect(image.startsWith(join(root, ".._thread_1", "shot-"))).toBe(true);
    expect(image.endsWith(".png")).toBe(true);
    expect(await readFile(image, "utf8")).toBe("png-bytes");
    expect((await stat(image)).mode & 0o777).toBe(0o600);
    expect(answer).toMatchObject({ typed: true });
    expect(answer).not.toHaveProperty("attachments");
  });

  it("sends files alone, and leaves an answer without files as it is", async () => {
    const save = answerImageSaver(await scratch());
    expect(await answerWithFiles({ value: " ", attachments: [file] }, "t", save)).toEqual({ value: "Attached files:\n- /work/notes.md" });
    expect(await answerWithFiles({ value: "plain" }, "t", save)).toEqual({ value: "plain" });
    expect(await answerWithFiles({ confirmed: true }, "t", save)).toEqual({ confirmed: true });
  });
});

describe("ExtensionUiCoordinator with files in an answer", () => {
  it("settles the question with the files named, and without them when they cannot be written", async () => {
    const events: ThreadHostEvent[] = [];
    const logs: string[] = [];
    const coordinator = new ExtensionUiCoordinator((_thread, event) => events.push(event), (_thread, label) => logs.push(label), async () => "/saved/shot.png");
    const prompt: ExtensionUiPrompt = { id: "q1", sessionId: "s1", kind: "input", title: "Why?" };
    const pending = coordinator.ask(prompt);
    coordinator.answer("q1", { value: "because", typed: true, attachments: [png] });
    expect(await pending).toEqual({ value: "because\n\nAttached files:\n- /saved/shot.png", typed: true });

    const failing = new ExtensionUiCoordinator(() => undefined, (_thread, label) => logs.push(label), async () => { throw new Error("disk full"); });
    const second = failing.ask({ ...prompt, id: "q2" });
    failing.answer("q2", { value: "anyway", attachments: [png] });
    expect(await second).toEqual({ value: "anyway" });
    expect(logs).toContain("extension-ui.attachments.failed");
  });
});
