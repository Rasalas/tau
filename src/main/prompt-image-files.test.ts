import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UiPromptAttachment } from "../shared/contracts.js";
import { PromptImageFiles, promptImageFileName, promptImageFolder } from "./prompt-image-files.js";
import { PI_AGENT_RUNTIME_ADAPTER } from "./runtime-adapters.js";
import type { ThreadBackendPromptInput, ThreadRuntimeBackend } from "./runtime-types.js";
import { PiThreadRuntimeBackend } from "./thread-runtime-backend.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "tau-prompt-images-")); });
afterEach(() => rm(root, { recursive: true, force: true }));

const PNG = Buffer.from("not really a png");
const image: UiPromptAttachment = { kind: "image", name: "Screenshot 2026-10-30.png", mimeType: "image/png", data: PNG.toString("base64"), size: PNG.length };
const file: UiPromptAttachment = { kind: "file", name: "spec.md", mimeType: "text/markdown", path: "/work/spec.md", size: 10 };

/** A backend that records what reached its runtime; `admit` decides how it answers. */
function fixture(kind = "fixture", admit: (input: ThreadBackendPromptInput) => Promise<void> = async (input) => { input.onAdmitted?.(true); }) {
  const prompts: ThreadBackendPromptInput[] = [];
  const backend = {
    kind, threadId: "thread-1", cwd: "/work",
    prompt: async (input: ThreadBackendPromptInput) => { prompts.push(input); await admit(input); return {}; },
  } as unknown as ThreadRuntimeBackend;
  return { backend, prompts };
}

describe("an image sent with a prompt is also a file", () => {
  it("is saved in the thread's folder and follows the image as a file attachment", async () => {
    const files = new PromptImageFiles(root);
    const { attachments } = await files.withFiles("thread-1", [file, image]);
    const copy = attachments[2];
    expect(attachments.slice(0, 2)).toEqual([file, image]);
    expect(copy).toEqual({ kind: "file", name: promptImageFileName(image as never, PNG), mimeType: "image/png", path: join(promptImageFolder(root, "thread-1"), promptImageFileName(image as never, PNG)), size: PNG.length });
    expect(copy?.kind === "file" && await readFile(copy.path)).toEqual(PNG);
    expect(copy?.name).toMatch(/^[0-9a-f]{12}-Screenshot 2026-10-30\.png$/u);
  });

  it("does not copy a prompt without images, nor a file that is already one", async () => {
    const files = new PromptImageFiles(root);
    expect((await files.withFiles("thread-1", [file])).attachments).toEqual([file]);
    expect(await readdir(root)).toEqual([]);
  });

  it("keeps one copy of an image sent twice", async () => {
    const files = new PromptImageFiles(root);
    const first = await files.withFiles("thread-1", [image]);
    const second = await files.withFiles("thread-1", [image]);
    expect(second.attachments[1]).toEqual(first.attachments[1]);
    expect(await readdir(promptImageFolder(root, "thread-1"))).toHaveLength(1);
    // The second prompt made no copy, so its refusal leaves the first one's.
    await second.discard();
    expect(await readdir(promptImageFolder(root, "thread-1"))).toHaveLength(1);
  });

  it("refuses an image beyond the prompt's limits without writing it", async () => {
    const files = new PromptImageFiles(root);
    await expect(files.withFiles("thread-1", [{ ...image, size: 11 * 1024 * 1024 } as UiPromptAttachment])).rejects.toThrow();
    await expect(readdir(promptImageFolder(root, "thread-1"))).rejects.toThrow();
  });

  it("names an unnamed paste by its type, and keeps a hostile name inside the folder", () => {
    expect(promptImageFileName({ name: "", mimeType: "image/jpeg" }, PNG)).toMatch(/^[0-9a-f]{12}-image\.jpg$/u);
    expect(promptImageFileName({ name: "../../etc/passwd.webp", mimeType: "image/webp" }, PNG)).toMatch(/^[0-9a-f]{12}-passwd\.webp$/u);
    expect(promptImageFolder(root, "../other")).toBe(join(root, "other"));
  });

  it("goes away with the thread", async () => {
    const files = new PromptImageFiles(root);
    await files.withFiles("thread-1", [image]);
    await files.forget("thread-1");
    expect(await readdir(root)).toEqual([]);
  });
});

describe("a backend's prompt with the copies", () => {
  it("gets the image unchanged and its copy after it", async () => {
    const { backend, prompts } = fixture();
    const admitted = vi.fn();
    await new PromptImageFiles(root).wrap(backend).prompt({ text: "look", delivery: "prompt", attachments: [image], onAdmitted: admitted });
    expect(prompts[0]?.text).toBe("look");
    expect(prompts[0]?.attachments).toMatchObject([image, { kind: "file", mimeType: "image/png", size: PNG.length }]);
    expect(admitted).toHaveBeenCalledWith(true, undefined);
    expect(await readdir(promptImageFolder(root, "thread-1"))).toHaveLength(1);
  });

  it("passes a prompt without images through as it came", async () => {
    const { backend, prompts } = fixture();
    const input: ThreadBackendPromptInput = { text: "plain", delivery: "steer", attachments: [file] };
    await new PromptImageFiles(root).wrap(backend).prompt(input);
    expect(prompts[0]).toBe(input);
  });

  it("removes the copies of a prompt the runtime refused", async () => {
    const refused = fixture("fixture", async (input) => { input.onAdmitted?.(false, new Error("busy")); });
    await new PromptImageFiles(root).wrap(refused.backend).prompt({ text: "look", delivery: "prompt", attachments: [image], onAdmitted: () => undefined });
    await expect.poll(() => readdir(promptImageFolder(root, "thread-1"))).toEqual([]);

    const threw = fixture("fixture", async () => { throw new Error("gone"); });
    await expect(new PromptImageFiles(root).wrap(threw.backend).prompt({ text: "look", delivery: "prompt", attachments: [image] })).rejects.toThrow("gone");
    expect(await readdir(promptImageFolder(root, "thread-1"))).toEqual([]);
  });

  it("leaves a thread on another machine to that machine, which keeps the copy itself", async () => {
    const { backend, prompts } = fixture("machine");
    const wrapped = new PromptImageFiles(root).wrap(backend);
    expect(wrapped).toBe(backend);
    await wrapped.prompt({ text: "look", delivery: "prompt", attachments: [image] });
    expect(prompts[0]?.attachments).toEqual([image]);
    expect(await readdir(root)).toEqual([]);
  });
});

describe("the Pi backend with the copies", () => {
  function pi(streaming = false) {
    const order: string[] = [];
    const session = {
      isStreaming: streaming,
      prompt: vi.fn(async () => { order.push("prompt"); }),
      steer: vi.fn(async () => { order.push("steer"); }),
      followUp: vi.fn(async () => { order.push("followUp"); }),
      sendCustomMessage: vi.fn(async () => { order.push("note"); }),
      settingsManager: { getEnableSkillCommands: () => true },
      resourceLoader: { getExtensions: () => ({ extensions: [] }), getPrompts: () => ({ prompts: [] }), getSkills: () => ({ skills: [] }) },
    };
    return { instance: new PiThreadRuntimeBackend({ session } as never, PI_AGENT_RUNTIME_ADAPTER, { mapMessages: () => [] }), session, order };
  }
  const copy: UiPromptAttachment = { kind: "file", name: "abc-shot.png", mimeType: "image/png", path: "/data/prompt-images/t/abc-shot.png", size: 4 };

  it("names them in a hidden note just ahead of the message, which keeps the image and its own text", async () => {
    const { instance, session, order } = pi();
    await instance.prompt({ text: "look", delivery: "prompt", attachments: [image, copy] } as never);
    expect(session.sendCustomMessage).toHaveBeenCalledWith({ customType: "tau.runtime-context", content: `Attached files:\n- ${copy.path}`, display: false }, { triggerTurn: false });
    expect(session.prompt).toHaveBeenCalledWith("look", expect.objectContaining({ images: [{ type: "image", data: image.data, mimeType: "image/png" }] }));
    expect(order).toEqual(["note", "prompt"]);
  });

  it("queues the note with a steer during a run", async () => {
    const { instance, session, order } = pi(true);
    await instance.prompt({ text: "also this", delivery: "steer", attachments: [image, copy] } as never);
    expect(session.sendCustomMessage).toHaveBeenCalledWith(expect.objectContaining({ display: false }), { deliverAs: "steer" });
    expect(order).toEqual(["note", "steer"]);
  });

  it("sends no note without copies", async () => {
    const { instance, session } = pi();
    await instance.prompt({ text: "look", delivery: "prompt", attachments: [image] } as never);
    expect(session.sendCustomMessage).not.toHaveBeenCalled();
  });
});
