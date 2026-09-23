import { describe, expect, it, vi } from "vitest";
import { TurnAttachmentRegistry } from "./turn-attachments.js";
import { extensionSettings } from "./host-ports.js";

const frame = (id: string, at: number) => ({ id, at, mediaType: "image/jpeg", size: 10 });

describe("TurnAttachmentRegistry", () => {
  it("merges every provider's attachments by time and names their source", async () => {
    const registry = new TurnAttachmentRegistry();
    registry.forExtension("a.kit").provide({ list: () => [frame("1", 30)], read: async () => undefined });
    registry.forExtension("b.kit").provide({ list: async () => [frame("2", 10)], read: async (_thread, id) => ({ mediaType: "video/webm", data: id }) });

    expect(await registry.list("t")).toEqual([{ ...frame("2", 10), source: "b.kit" }, { ...frame("1", 30), source: "a.kit" }]);
    expect(await registry.read("t", "b.kit", "2")).toEqual({ mediaType: "video/webm", data: "2" });
    expect(await registry.read("t", "c.kit", "2")).toBeUndefined();
  });

  it("leaves out a provider that fails, and forgets one that withdrew", async () => {
    const log = vi.fn();
    const registry = new TurnAttachmentRegistry(log);
    registry.forExtension("bad.kit").provide({ list: () => { throw new Error("disk gone"); }, read: async () => undefined });
    const withdraw = registry.forExtension("good.kit").provide({ list: () => [frame("1", 1)], read: async () => undefined });

    expect((await registry.list("t")).map((entry) => entry.source)).toEqual(["good.kit"]);
    expect(log).toHaveBeenCalledWith("turn-attachments.list-failed", "bad.kit: disk gone");
    withdraw();
    expect(await registry.list("t")).toEqual([]);
  });

  it("tells observers which source changed which thread", () => {
    const registry = new TurnAttachmentRegistry();
    const heard: string[] = [];
    const stop = registry.forExtension("reader.kit").observe((threadId, source) => heard.push(`${source}:${threadId}`));
    registry.forExtension("maker.kit").changed("t1");
    stop();
    registry.forExtension("maker.kit").changed("t2");
    expect(heard).toEqual(["maker.kit:t1"]);
  });
});

describe("extensionSettings", () => {
  it("answers only the extension's own entries, without its id in front", async () => {
    const readConfig = vi.fn(async () => ({
      options: { "tau.evidence.preview": false, "tau.evidence-other.x": true, "other.kit.preview": true },
      values: { "tau.evidence.retention-days": "7" },
    }));
    expect(await extensionSettings({ readConfig }, "tau.evidence", "/project")).toEqual({ options: { preview: false }, values: { "retention-days": "7" } });
    expect(readConfig).toHaveBeenCalledWith("/project");
    expect(await extensionSettings({}, "tau.evidence")).toEqual({ options: {}, values: {} });
  });
});
