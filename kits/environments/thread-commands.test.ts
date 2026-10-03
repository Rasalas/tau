import { describe, expect, it, vi } from "vitest";
import type { HostExtensionServices, HostSessionSummary } from "tau/host-extension";
import { activateHostKit } from "../../src/main/test-support/host-kit-harness.js";
import { createEnvironmentsHostExtension } from "./host.js";

const local: HostSessionSummary = { sessionId: "saved", path: "/sessions/saved.jsonl", cwd: "/project" };
const proxy: HostSessionSummary = { sessionId: "other~saved", path: "tau-thread:machine:other~saved", cwd: "/remote" };
const image = { kind: "image", name: "x.png", mimeType: "image/png", data: "AA==", size: 1 };

async function home(overrides: { sessions?: Partial<HostExtensionServices["sessions"]> } = {}) {
  const setThreadTitle = vi.fn(async () => undefined);
  const send = vi.fn(async () => undefined);
  const setModel = vi.fn(async () => undefined);
  const registry = await activateHostKit(createEnvironmentsHostExtension(), {
    setThreadTitle,
    sessions: { list: async () => [local, proxy], send, setModel, ...overrides.sessions } as HostExtensionServices["sessions"],
  });
  return { registry, setThreadTitle, send, setModel, invoke: (command: string, input: unknown) => registry.invoke("tau.environments", command, input) };
}

describe("the home machine's thread commands", () => {
  it("renames a thread of its own with the user's title", async () => {
    const h = await home();
    await h.invoke("thread-rename", { sessionId: "saved", title: "  Better name " });
    expect(h.setThreadTitle).toHaveBeenCalledExactlyOnceWith("saved", "Better name", "renamed");
  });

  it.each([["", "must be a non-empty string"], ["   ", "cannot be empty"], ["x".repeat(121), "120 characters or fewer"]])("refuses the title %j", async (title, reason) => {
    const h = await home();
    await expect(h.invoke("thread-rename", { sessionId: "saved", title })).rejects.toThrow(reason);
    expect(h.setThreadTitle).not.toHaveBeenCalled();
  });

  it("refuses a thread it does not have and a proxy of a third machine", async () => {
    const h = await home();
    await expect(h.invoke("thread-rename", { sessionId: "missing", title: "x" })).rejects.toThrow("does not exist on this machine");
    await expect(h.invoke("thread-model", { sessionId: proxy.sessionId, provider: "p", id: "m" })).rejects.toThrow("lives on another machine");
    await expect(h.invoke("thread-send", { sessionId: proxy.sessionId, text: "x" })).rejects.toThrow("lives on another machine");
    expect(h.setThreadTitle).not.toHaveBeenCalled();
    expect(h.setModel).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
  });

  it("changes the model of the named thread", async () => {
    const h = await home();
    await h.invoke("thread-model", { sessionId: "saved", provider: "openai", id: "gpt-small" });
    expect(h.setModel).toHaveBeenCalledExactlyOnceWith("saved", "openai", "gpt-small");
    await expect(h.invoke("thread-model", { sessionId: "saved", provider: "openai" })).rejects.toThrow("id must be");
  });

  it("says plainly when this host cannot change a model off screen", async () => {
    const h = await home({ sessions: { setModel: undefined } });
    await expect(h.invoke("thread-model", { sessionId: "saved", provider: "openai", id: "m" })).rejects.toThrow("cannot change the model");
  });

  it("sends images as content with the delivery asked for", async () => {
    const h = await home();
    await h.invoke("thread-send", { sessionId: "saved", text: "look", delivery: "queue", attachments: [image] });
    expect(h.send).toHaveBeenCalledExactlyOnceWith("saved", "look", { delivery: "queue", attachments: [image] });
  });

  it("never takes a path: a file attachment is refused before anything is sent", async () => {
    const h = await home();
    const file = { kind: "file", name: "passwd", mimeType: "text/plain", path: "/etc/passwd", size: 1 };
    await expect(h.invoke("thread-send", { sessionId: "saved", text: "x", attachments: [image, file] })).rejects.toThrow("not a sender path");
    await expect(h.invoke("thread-send", { sessionId: "saved", text: "x", attachments: [{ kind: "image", name: "x", path: "/etc/passwd" }] })).rejects.toThrow("mimeType");
    await expect(h.invoke("thread-send", { sessionId: "saved", text: "x", delivery: "later" })).rejects.toThrow("delivery must be");
    expect(h.send).not.toHaveBeenCalled();
  });
});
