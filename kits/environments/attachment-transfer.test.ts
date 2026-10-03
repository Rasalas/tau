import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { HostExtensionServices, HostMachineServices, UiPromptAttachment } from "tau/host-extension";
import { activateHostKit } from "../../src/main/test-support/host-kit-harness.js";
import { createEnvironmentsHostExtension } from "./host.js";
import { MachineThreadBackend } from "./machine-backend.js";

const ID = "tau.environments";

describe("Machines Kit attachment delivery", () => {
  it("carries images and files into an existing checkout and later into its thread", async () => {
    const root = await mkdtemp(join(tmpdir(), "tau-machine-attachments-"));
    const start = vi.fn(async () => ({ sessionId: "saved", cwd: "/rex/project" }));
    const send = vi.fn(async () => undefined);
    const caller = { kind: "workbench-client" as const, connection: "agents", pairedClient: "mac-agents" };
    const blobPaths = new Map<string, string>();
    const receiver = await activateHostKit(createEnvironmentsHostExtension(), {
      stateDir: join(root, "rex"),
      knownWorkspacePath: async (id) => { expect(id).toBe("ws-rex"); return "/rex/project"; },
      sessions: { start, send, list: async () => [{ sessionId: "saved", path: "/rex/session", cwd: "/rex/project" }] } as unknown as HostExtensionServices["sessions"],
      blobs: { take: async (id, use, options) => {
        expect(options?.caller?.device).toBe("mac-agents");
        const path = blobPaths.get(id)!;
        const size = (await readFile(path)).length;
        return use({ id, path, size, sha256: "checked-by-upload", device: "mac-agents" });
      } },
    });
    const machines: HostMachineServices = {
      self: { id: "mac", name: "Mac", version: "1" }, list: () => [{ id: "rex", name: "rex", status: "connected", address: "wss://rex/" }],
      subscribe: () => () => undefined, watch: () => () => undefined,
      request: vi.fn(async () => { throw new Error("Attachments must use the receiving kit"); }),
      call: vi.fn(async (_machine, extension, command, input) => receiver.invoke(extension, command, structuredClone(input), caller)),
      upload: async (_machine, source) => {
        const chunks: Uint8Array[] = [];
        if (source instanceof Uint8Array) chunks.push(source);
        else for await (const chunk of source) chunks.push(chunk);
        const data = Buffer.concat(chunks);
        const id = `blob-${blobPaths.size}`;
        const path = join(root, id);
        await writeFile(path, data);
        blobPaths.set(id, path);
        return { id, size: data.length, sha256: "checked-by-upload" };
      },
    };
    const sender = await activateHostKit(createEnvironmentsHostExtension(), { machines });
    try {
      const path = join(root, "mac-spec.txt");
      await writeFile(path, "read on rex");
      const image = { kind: "image" as const, name: "shot.png", mimeType: "image/png", data: "AA==", size: 1 };
      const attachments: UiPromptAttachment[] = [image, { kind: "file", name: "spec.txt", mimeType: "text/plain", path, size: 11 }];
      await sender.invoke(ID, "start-there", { machine: "rex", workspaceId: "ws-rex", prompt: "look", backend: "codex", attachments });
      const started = start.mock.calls[0] as unknown as [{ cwd: string; attachments: UiPromptAttachment[] }];
      expect(started[0].cwd).toBe("/rex/project");
      expect(started[0].attachments[0]).toEqual(image);
      const firstFile = started[0].attachments[1];
      if (firstFile?.kind !== "file") throw new Error("Missing received file");
      expect(firstFile.path).not.toBe(path);
      expect(await readFile(firstFile.path, "utf8")).toBe("read on rex");
      const backend = new MachineThreadBackend("rex~saved", "/rex/project", machines, { projectName: "project", permissionLevel: () => "full", onEvent: vi.fn(), onMessage: vi.fn(), ask: vi.fn() });
      await backend.prompt({ text: "again", attachments, delivery: "steer" });
      const sent = send.mock.calls[0] as unknown as [string, string, { attachments: UiPromptAttachment[]; delivery: string }];
      expect(sent.slice(0, 2)).toEqual(["saved", "again"]);
      expect(sent[2].delivery).toBe("steer");
      expect(sent[2].attachments[0]).toEqual(image);
      const nextFile = sent[2].attachments[1];
      if (nextFile?.kind !== "file") throw new Error("Missing follow-up file");
      expect(nextFile.path).not.toBe(path);
      expect(await readFile(nextFile.path, "utf8")).toBe("read on rex");
      expect(machines.request).not.toHaveBeenCalled();
    } finally {
      await sender.dispose();
      await receiver.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
});
