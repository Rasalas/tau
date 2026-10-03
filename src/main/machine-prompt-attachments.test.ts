import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostCommandCall, HostMachineServices } from "./host-extensions.js";
import { createBlobMethods, HostBlobStore, sendBlob } from "./host-blobs.js";
import { invokeHostMethod } from "./host-methods.js";
import { decodeTransferredPromptAttachments, transferPromptAttachments, withReceivedPromptAttachments } from "./machine-prompt-attachments.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const caller: HostCommandCall = { owner: false, device: "mac-agents" };
const principal = { kind: "workbench-client" as const, connection: "c1", pairedClient: "mac-agents" };
const image = { kind: "image" as const, name: "shot.png", mimeType: "image/png", data: "AA==", size: 1 };

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tau-prompt-transfer-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const blobs = await HostBlobStore.open({ dir: join(root, "blobs"), freeBytes: async () => 1e9, scheduleSweep: () => () => undefined });
  cleanup.push(async () => { blobs.close(); });
  const methods = createBlobMethods(() => blobs);
  const upload = vi.fn<HostMachineServices["upload"]>((_machine, source, options) => sendBlob(
    (method, params) => invokeHostMethod(methods, method, params, principal), source, options,
  ));
  const machines = { upload } as unknown as HostMachineServices;
  const services = { stateDir: join(root, "kit"), blobs };
  const path = join(root, "source.txt");
  await writeFile(path, "portable bytes");
  const file = { kind: "file" as const, name: "..\\CON:/spec.txt", mimeType: "text/plain", path, size: 14 };
  return { root, services, machines, upload, file };
}

describe("prompt attachments across machine connections", () => {
  it("uploads bytes, retains a safe receiving path and never carries a sender path", async () => {
    const f = await fixture();
    const input = await transferPromptAttachments(f.machines, "rex", [image, f.file]);
    expect(input[0]).toEqual(image);
    expect(input[1]).toMatchObject({ kind: "file", size: 14, blob: expect.any(String) });
    expect(input[1]).not.toHaveProperty("path");
    const received = await withReceivedPromptAttachments(f.services, input, caller, async (attachments) => attachments);
    expect(received[0]).toEqual(image);
    const file = received[1];
    if (file?.kind !== "file") throw new Error("Missing received file");
    expect(file.path.startsWith(join(f.services.stateDir, "attachments"))).toBe(true);
    expect(await readFile(file.path, "utf8")).toBe("portable bytes");
    await expect(withReceivedPromptAttachments(f.services, input, caller, async () => undefined)).rejects.toThrow();
  });

  it("does not take another device's blob and leaves it for its owner", async () => {
    const f = await fixture();
    const input = await transferPromptAttachments(f.machines, "rex", [f.file]);
    const use = vi.fn(async () => undefined);
    await expect(withReceivedPromptAttachments(f.services, input, { owner: false, device: "other" }, use)).rejects.toThrow();
    expect(use).not.toHaveBeenCalled();
    await withReceivedPromptAttachments(f.services, input, caller, use);
    expect(use).toHaveBeenCalledOnce();
  });

  it("removes copies when admission rejects or a later attachment fails", async () => {
    const f = await fixture();
    const input = await transferPromptAttachments(f.machines, "rex", [f.file]);
    await expect(withReceivedPromptAttachments(f.services, input, caller, async () => { throw new Error("Model unavailable"); })).rejects.toThrow("Model unavailable");
    expect(await readdir(join(f.services.stateDir, "attachments"))).toEqual([]);
    const next = await transferPromptAttachments(f.machines, "rex", [f.file]);
    const file = next[0];
    if (file?.kind !== "file") throw new Error("Missing wire file");
    const use = vi.fn(async () => undefined);
    await expect(withReceivedPromptAttachments(f.services, [file, { ...file, blob: "missing" }], caller, use)).rejects.toThrow();
    expect(use).not.toHaveBeenCalled();
    expect(await readdir(join(f.services.stateDir, "attachments"))).toEqual([]);
  });

  it("rejects a size mismatch and sender paths before admission", async () => {
    const f = await fixture();
    expect(() => decodeTransferredPromptAttachments([f.file])).toThrow("not a sender path");
    const input = await transferPromptAttachments(f.machines, "rex", [f.file]);
    const file = input[0];
    if (file?.kind !== "file") throw new Error("Missing wire file");
    await expect(withReceivedPromptAttachments(f.services, [{ ...file, size: 15 }], caller, async () => undefined)).rejects.toThrow("does not match");
    expect(() => decodeTransferredPromptAttachments([{ ...file, size: 51 * 1024 * 1024 }])).toThrow();
    expect(() => decodeTransferredPromptAttachments(Array(101).fill(image))).toThrow();
  });
});
