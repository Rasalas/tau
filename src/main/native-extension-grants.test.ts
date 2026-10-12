import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { duplexPair } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { answerNativeExtensionGrants, connectNativeExtensionGrants, NativeExtensionGrants, serveNativeExtensionGrants } from "./native-extension-grants.js";

const pkg = { id: "acme.pending", name: "Pending", scope: "global" as const, directory: "/packages/pending", desktop: true, host: true };

describe("native package confirmation channel", () => {
  it("connects the host and native window through their local pipe", async () => {
    const userData = await mkdtemp(join(tmpdir(), "tau-native-grants-"));
    let connected!: () => void;
    const attached = new Promise<void>((resolve) => { connected = resolve; });
    const original = NativeExtensionGrants.prototype.attach;
    const attach = vi.spyOn(NativeExtensionGrants.prototype, "attach").mockImplementation(function (this: NativeExtensionGrants, socket) {
      original.call(this, socket);
      connected();
    });
    let channel: Awaited<ReturnType<typeof serveNativeExtensionGrants>> | undefined;
    let disconnect: (() => void) | undefined;
    try {
      channel = await serveNativeExtensionGrants(userData);
      const confirm = vi.fn(async () => true);
      disconnect = connectNativeExtensionGrants(userData, confirm);
      await attached;
      await expect(channel.confirm(pkg)).resolves.toBe(true);
      expect(confirm).toHaveBeenCalledWith(pkg);
    } finally {
      disconnect?.();
      channel?.close();
      attach.mockRestore();
      await rm(userData, { recursive: true, force: true });
    }
  });
  it("refuses without a native peer", async () => {
    await expect(new NativeExtensionGrants().confirm(pkg)).resolves.toBe(false);
  });

  it.each([true, false])("uses the window's native dialog answer: %s", async (accepted) => {
    const channel = new NativeExtensionGrants();
    const [host, window] = duplexPair();
    const confirm = vi.fn(async () => accepted);
    channel.attach(host);
    answerNativeExtensionGrants(window, confirm);
    try {
      await expect(channel.confirm(pkg)).resolves.toBe(accepted);
      expect(confirm).toHaveBeenCalledWith(pkg);
    } finally { channel.close(); window.destroy(); }
  });

  it("rejects an answer on another native connection, even if it knows the request id", async () => {
    const channel = new NativeExtensionGrants();
    const [host, window] = duplexPair();
    const [otherHost, otherWindow] = duplexPair();
    channel.attach(host);
    try {
      const received = once(window, "data");
      const pending = channel.confirm(pkg);
      const [data] = await received;
      const { id } = JSON.parse(String(data)) as { id: string };
      channel.attach(otherHost);
      const delivered = once(otherHost, "data");
      otherWindow.write(`${JSON.stringify({ id, accepted: true })}\n`);
      await delivered;
      window.write(`${JSON.stringify({ id, accepted: false })}\n`);
      await expect(pending).resolves.toBe(false);
    } finally { channel.close(); window.destroy(); otherWindow.destroy(); }
  });

  it("refuses if the native window disconnects or its dialog fails", async () => {
    const channel = new NativeExtensionGrants();
    const [host, window] = duplexPair();
    channel.attach(host);
    const pending = channel.confirm(pkg);
    host.destroy();
    await expect(pending).resolves.toBe(false);
    window.destroy();
    const [nextHost, nextWindow] = duplexPair();
    channel.attach(nextHost);
    answerNativeExtensionGrants(nextWindow, async () => { throw new Error("dialog unavailable"); });
    try { await expect(channel.confirm(pkg)).resolves.toBe(false); }
    finally { channel.close(); nextWindow.destroy(); }
  });
});
