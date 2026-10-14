// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComposerInlineContext, HostSnapshot } from "tau";
import { THREAD_PULL_REQUESTS_SERVICE, type ThreadPullRequest, type ThreadPullRequestsService } from "tau";
import { createKitHarness } from "../../src/renderer/test-support/kit-harness.js";
import composerContext, { ExcerptDetail, parseFileQuery, storeInChunks, storeWithRetry } from "./desktop.js";
import { ChipStore } from "./chips.js";
import { COMPOSER_CONTEXT_CHIPS_SERVICE, COMPOSER_CONTEXT_ID, PASTE_FOLD_BYTES, UPLOAD_CHUNK_BYTES, type ComposerContextChips, type PullRequestSummary } from "./protocol.js";

afterEach(cleanup);

const SCOPE = "session:t1";
const snapshot = { cwd: "/repo", sessionId: "t1" } as HostSnapshot;
const inline = (overrides: Partial<ComposerInlineContext> = {}): ComposerInlineContext => ({ scope: SCOPE, snapshot, fileAttachments: false, imageInput: true, ...overrides });

const linkedRequests: ThreadPullRequest[] = [
  { url: "https://github.com/fork/stack/pull/42", number: 42, host: "github.com", repo: "fork/stack", title: "Merged stack", state: "merged", headRef: "stack" },
  { url: "https://forge.example/acme/demo/pulls/42", number: 42, host: "forge.example", repo: "acme/demo", title: "Closed fix", state: "closed" },
  { url: "https://dev.azure.com/acme/demo/_git/demo/pullrequest/43", number: 43, host: "dev.azure.com", repo: "acme/demo", title: "Draft fix", state: "open", draft: true, headRef: "draft-fix" },
  { url: "https://bitbucket.org/acme/other/pull-requests/44", number: 44, host: "bitbucket.org", repo: "acme/other" },
];

function pullRequestSearch() {
  const invoke = vi.fn(async (): Promise<PullRequestSummary[]> => [
    { number: 40, title: "Open fix", url: "https://github.com/acme/demo/pull/40" },
    { number: 42, title: "Old title", url: linkedRequests[0]!.url },
  ]);
  const { registry } = createKitHarness(invoke);
  registry.activate(composerContext);
  const forThread = vi.fn((sessionId: string) => sessionId === "t1" ? linkedRequests : []);
  const service: ThreadPullRequestsService = { forThread, subscribe: () => () => {} };
  const provide = () => registry.activate({
    id: "test.requests", name: "Requests", activate(context) { context.provideService(THREAD_PULL_REQUESTS_SERVICE, service); },
  });
  provide();
  const contribution = registry.getComposerInlines()[0]!;
  const trigger = contribution.triggers!.find((entry) => entry.char === "#")!;
  return { registry, invoke, forThread, provide, contribution, trigger };
}

describe("Composer Context linked pull request suggestions", () => {
  it("puts linked requests from every repository and state first, deduplicates by URL, and selects a chip", async () => {
    const { trigger, contribution, forThread } = pullRequestSearch();
    const items = await trigger.search("", inline());
    expect(forThread).toHaveBeenCalledWith("t1");
    expect(items.map((item) => JSON.parse(item.id).url)).toEqual([
      ...linkedRequests.map((pr) => pr.url), "https://github.com/acme/demo/pull/40",
    ]);
    expect(items[0]).toMatchObject({ label: "#42 Merged stack", description: "stack" });
    expect(items[2]).toMatchObject({ description: "draft-fix", hint: "draft" });
    expect(items[3]?.label).toContain("acme/other");
    trigger.select(items[0]!, "", inline());
    expect(contribution.chips!.list(SCOPE)[0]).toMatchObject({ label: "#42" });
    expect((await contribution.prepareSend!({ ...inline(), text: "" }))?.context)
      .toBe("Pull request [#42](https://github.com/fork/stack/pull/42): Merged stack");
  });

  it("filters both sources by number prefix or case-insensitive title", async () => {
    const { trigger } = pullRequestSearch();
    expect((await trigger.search("42", inline())).map((item) => JSON.parse(item.id).url))
      .toEqual(linkedRequests.slice(0, 2).map((pr) => pr.url));
    expect((await trigger.search("FiX", inline())).map((item) => JSON.parse(item.id).title))
      .toEqual(["Closed fix", "Draft fix", "Open fix"]);
    expect(await trigger.search("missing", inline())).toEqual([]);
  });

  it.each([
    "Install gh or glab to list pull requests.", "The pull requests of this project could not be listed.",
  ])("keeps linked requests when the host fails: %s", async (message) => {
    const { trigger, invoke } = pullRequestSearch();
    invoke.mockRejectedValue(new Error(message));
    expect((await trigger.search("", inline())).map((item) => JSON.parse(item.id).url))
      .toEqual(linkedRequests.map((pr) => pr.url));
    expect(await trigger.search("missing", inline())).toEqual([]);
  });

  it("offers linked requests without a workspace", async () => {
    const { trigger, invoke } = pullRequestSearch();
    const items = await trigger.search("", inline({ snapshot: { sessionId: "t1" } as HostSnapshot }));
    expect(items.map((item) => JSON.parse(item.id).url)).toEqual(linkedRequests.map((pr) => pr.url));
    expect(invoke).not.toHaveBeenCalled();
  });

  it("reads only the current thread and releases a withdrawn service", async () => {
    const { trigger, registry, invoke, forThread, provide } = pullRequestSearch();
    invoke.mockResolvedValue([]);
    expect(await trigger.search("", inline({ snapshot: { ...snapshot, sessionId: "t2" } }))).toEqual([]);
    expect(forThread).toHaveBeenCalledWith("t2");
    forThread.mockClear();
    expect(await trigger.search("", inline({ snapshot: undefined }))).toEqual([]);
    expect(forThread).not.toHaveBeenCalled();
    registry.deactivate("test.requests");
    expect(await trigger.search("", inline())).toEqual([]);
    expect(forThread).not.toHaveBeenCalled();
    provide();
    expect(await trigger.search("", inline())).toHaveLength(linkedRequests.length);
  });

  it("preserves the host error when the thread has no linked requests", async () => {
    const { trigger, invoke } = pullRequestSearch();
    invoke.mockRejectedValue(new Error("Install gh or glab to list pull requests."));
    await expect(trigger.search("", inline({ snapshot: { ...snapshot, sessionId: "t2" } })))
      .rejects.toThrow("Install gh or glab");
  });
});

function activate(storeAttachment?: () => void) {
  const invoke = vi.fn(async (_id: string, command: string, input?: unknown): Promise<unknown> => {
    const fields = input as Record<string, unknown>;
    switch (command) {
      case "store-attachment": storeAttachment?.(); return { path: `/state/attachments/t1/${String(fields.name)}`, size: atob(String(fields.data)).length };
      case "read-files": return (fields.files as Array<{ path: string }>).map((file) => ({ path: file.path, text: `contents of ${file.path}` }));
      case "describe-attachments": return (fields.paths as string[]).map((path) => ({ path, ...(path.endsWith(".txt") ? { text: "folded text" } : {}) }));
      case "list-files": return ["src/notes.md", "src/alpha.ts"];
      case "list-pull-requests": return [{ number: 42, title: "Chips", url: "https://example.test/pr/42", branch: "chips" }];
      default: throw new Error(`unexpected ${command}`);
    }
  });
  const { registry } = createKitHarness(invoke);
  registry.activate(composerContext);
  const [contribution] = registry.getComposerInlines();
  let service: ComposerContextChips | undefined;
  registry.activate({ id: "test.consumer", name: "Consumer", activate(context) { context.useService<ComposerContextChips>(COMPOSER_CONTEXT_CHIPS_SERVICE, (value) => { service = value; }); } });
  const saved: { value?: unknown } = {};
  const draftState = { read: () => saved.value, write: (value: unknown) => { saved.value = value; } };
  const Strip = contribution!.Component!;
  const view = render(<Strip {...inline()} draftState={draftState} />);
  const labels = () => contribution!.chips!.list(SCOPE).map((chip) => chip.label);
  return { contribution: contribution!, invoke, service: () => service!, saved, view, draftState, Strip, registry, labels };
}

describe("Composer Context desktop", () => {
  it("lets another kit add a chip through the service and hands it to core to draw in the text", async () => {
    const { service, contribution, labels } = activate();
    let id = "";
    act(() => { id = service().addChip({ kind: "text-excerpt", payload: { source: "Terminal", text: "$ ls" } }); });
    expect(labels()).toEqual(["Terminal"]);
    expect(service().chips().map((chip) => chip.id)).toEqual([id]);
    // The strip no longer draws chips; they are in the text.
    expect(screen.queryByText("Terminal")).toBeNull();
    expect(contribution.chips!.list(SCOPE)[0]).toMatchObject({ id, label: "Terminal" });
    expect(contribution.chips!.list(SCOPE)[0]?.Detail).toBeDefined();
    act(() => contribution.chips!.remove(SCOPE, id));
    expect(service().chips()).toEqual([]);
  });

  it("draws a sent excerpt as a block of user messages, on every profile", () => {
    const { registry } = activate();
    const block = registry.getMessageBlocks().find((entry) => entry.tag === "excerpt")!;
    expect(block.roles).toEqual(["user"]);
    expect(block.profiles).toEqual(["desktop", "web", "compact"]);
  });

  it("keeps a comment on an excerpt and sends it below the quote", async () => {
    const { service, contribution } = activate();
    act(() => { service().addChip({ kind: "text-excerpt", payload: { source: "Terminal", text: "$ ls\nboom" } }); });
    const [chip] = contribution.chips!.list(SCOPE);
    const Detail = chip!.Detail!;
    const close = vi.fn();
    render(<Detail scope={SCOPE} chipId={chip!.id} close={close} />);
    fireEvent.change(screen.getByLabelText("Comment on this excerpt"), { target: { value: "why does this fail?" } });
    fireEvent.keyDown(screen.getByLabelText("Comment on this excerpt"), { key: "Enter" });
    expect(close).toHaveBeenCalledOnce();
    const sent = await contribution.prepareSend!({ ...inline(), text: "" });
    expect(sent?.context).toBe("<excerpt>\nFrom Terminal:\n> $ ls\n> boom\n\nMy comment on this excerpt: why does this fail?\n</excerpt>");
  });

  it("draws no comment field for a chip that is not an excerpt", () => {
    const store = new ChipStore();
    const chip = store.add(SCOPE, { kind: "file", payload: { path: "a.ts" } });
    const { container } = render(<ExcerptDetail store={store} scope={SCOPE} chipId={chip.id} close={() => {}} />);
    expect(container.innerHTML).toBe("");
  });

  it("uploads a file again once the host is back after the upload gave up", async () => {
    vi.useFakeTimers();
    let down = true;
    const { contribution, registry } = activate(() => { if (down) throw new Error("The host connection dropped."); });
    const pdf = new File(["%PDF-1.4"], "spec.pdf", { type: "application/pdf" });
    act(() => { contribution.takeFiles!([pdf], inline()); });
    expect(contribution.chips!.list(SCOPE)[0]?.state).toBe("busy");
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(contribution.chips!.list(SCOPE)[0]?.state).toBe("failed");
    vi.useRealTimers();
    down = false;
    act(() => registry.dispatchWorkbenchEvent({ type: "host-connection", state: "reconnecting" }));
    act(() => registry.dispatchWorkbenchEvent({ type: "host-connection", state: "connected" }));
    await waitFor(() => expect(contribution.chips!.list(SCOPE)[0]?.state).toBeUndefined());
    const sent = await contribution.prepareSend!({ ...inline({ fileAttachments: true }), text: "" });
    expect(sent?.attachments).toEqual([expect.objectContaining({ name: "spec.pdf", path: "/state/attachments/t1/spec.pdf" })]);
  });

  it("turns @ into a file chip with its lines, and sends the file as a block before the text", async () => {
    const { contribution, invoke, labels } = activate();
    const trigger = contribution.triggers!.find((entry) => entry.char === "@")!;
    const items = await trigger.search("alpha.ts:2-4", inline());
    expect(invoke).toHaveBeenCalledWith(COMPOSER_CONTEXT_ID, "list-files", { cwd: "/repo", query: "alpha.ts" });
    act(() => trigger.select(items[1]!, "alpha.ts:2-4", inline()));
    expect(labels()).toEqual(["alpha.ts:2-4"]);
    expect(contribution.hasContent!(SCOPE)).toBe(true);

    const sent = await contribution.prepareSend!({ ...inline(), text: "explain" });
    expect(invoke).toHaveBeenCalledWith(COMPOSER_CONTEXT_ID, "read-files", { cwd: "/repo", files: [{ path: "src/alpha.ts", startLine: 2, endLine: 4 }] });
    expect(sent).toEqual({ context: '<file path="src/alpha.ts" lines="2-4">\ncontents of src/alpha.ts\n</file>', attachments: [] });
    act(() => contribution.settleSend!(SCOPE, true));
    expect(contribution.hasContent!(SCOPE)).toBe(false);
  });

  it("turns # into a pull request chip", async () => {
    const { contribution } = activate();
    const trigger = contribution.triggers!.find((entry) => entry.char === "#")!;
    const [item] = await trigger.search("4", inline());
    expect(item?.label).toBe("#42 Chips");
    act(() => trigger.select(item!, "4", inline()));
    const sent = await contribution.prepareSend!({ ...inline(), text: "" });
    expect(sent?.context).toBe("Pull request [#42](https://example.test/pr/42): Chips");
  });

  it("folds a large paste into a text attachment, embedded for a runtime that cannot open files", async () => {
    const { contribution, invoke, saved, labels } = activate();
    expect(contribution.pasteText!("short", inline())).toBe(false);
    let taken = false;
    act(() => { taken = contribution.pasteText!("z".repeat(PASTE_FOLD_BYTES + 5), inline()); });
    expect(taken).toBe(true);
    expect(labels()).toEqual(["pasted-text-1.txt"]);
    const sent = await contribution.prepareSend!({ ...inline(), text: "summarise" });
    expect(invoke).toHaveBeenCalledWith(COMPOSER_CONTEXT_ID, "store-attachment", expect.objectContaining({ scope: SCOPE, name: "pasted-text-1.txt", mimeType: "text/plain" }));
    expect(sent?.context).toBe('<file path="/state/attachments/t1/pasted-text-1.txt" name="pasted-text-1.txt">\nfolded text\n</file>');
    // Refused: the chip comes back, and so does what the draft keeps.
    act(() => contribution.settleSend!(SCOPE, false));
    expect(labels()).toEqual(["pasted-text-1.txt"]);
    expect(saved.value).toMatchObject({ chips: [{ kind: "attachment", label: "pasted-text-1.txt" }] });
  });

  it("takes a dropped PDF as a file for a runtime that opens files, and leaves images to core", async () => {
    const { contribution, labels } = activate();
    const pdf = new File(["%PDF-1.4"], "spec.pdf", { type: "application/pdf" });
    const png = new File(["x"], "shot.png", { type: "image/png" });
    let left: readonly File[] = [];
    act(() => { left = contribution.takeFiles!([pdf, png], inline()); });
    expect(left).toEqual([png]);
    await waitFor(() => expect(labels()).toEqual(["spec.pdf"]));
    const sent = await contribution.prepareSend!({ ...inline({ fileAttachments: true }), text: "read it" });
    expect(sent).toEqual({ context: "", attachments: [{ kind: "file", name: "spec.pdf", mimeType: "application/pdf", path: "/state/attachments/t1/spec.pdf", size: 8 }] });
  });

  it("says why it refused a file", () => {
    const { contribution } = activate();
    const huge = new File(["x"], "huge.iso", { type: "application/octet-stream" });
    Object.defineProperty(huge, "size", { value: 60 * 1024 * 1024 });
    act(() => { contribution.takeFiles!([huge], inline()); });
    expect(screen.getByRole("alert").textContent).toMatch(/huge\.iso is larger than 50 MB/u);
  });

  it("brings a draft's chips back after a reload", async () => {
    const { service, saved, Strip } = activate();
    act(() => { service().addChip({ kind: "file", payload: { path: "src/a.ts" } }); });
    cleanup();
    const again = createKitHarness(vi.fn());
    again.registry.activate(composerContext);
    const reloaded = again.registry.getComposerInlines()[0]!;
    const Reloaded = reloaded.Component!;
    expect(Reloaded).not.toBe(Strip);
    render(<Reloaded {...inline()} draftState={{ read: () => saved.value, write: () => undefined }} />);
    await waitFor(() => expect(reloaded.chips!.list(SCOPE).map((chip) => chip.label)).toEqual(["a.ts"]));
  });

  it("sends a file larger than one chunk in pieces, each continuing the first", async () => {
    const calls: Array<{ bytes: number; into?: string }> = [];
    const host = (async (_command: string, input: { data: string; into?: string }) => {
      calls.push({ bytes: atob(input.data).length, ...(input.into ? { into: input.into } : {}) });
      return { path: "/state/a.bin", size: calls.reduce((sum, call) => sum + call.bytes, 0) };
    }) as never;
    const size = UPLOAD_CHUNK_BYTES * 2 + 3;
    const stored = await storeInChunks(host, { scope: SCOPE, name: "a.bin", mimeType: "", size }, async (start, end) => new Uint8Array(end - start));
    expect(calls).toEqual([
      { bytes: UPLOAD_CHUNK_BYTES },
      { bytes: UPLOAD_CHUNK_BYTES, into: "/state/a.bin" },
      { bytes: 3, into: "/state/a.bin" },
    ]);
    expect(stored).toEqual({ path: "/state/a.bin", size });
  });

  it("uploads again after the connection dropped, and gives up on a refusal", async () => {
    let calls = 0;
    const host = (async () => {
      calls += 1;
      if (calls === 1) throw new Error("The host connection dropped.");
      return { path: "/state/a.bin", size: 1 };
    }) as never;
    const waits: number[] = [];
    const wait = async (ms: number) => { waits.push(ms); };
    await expect(storeWithRetry(host, { scope: SCOPE, name: "a.bin", mimeType: "", size: 1 }, async () => new Uint8Array(1), wait))
      .resolves.toEqual({ path: "/state/a.bin", size: 1 });
    expect(waits).toEqual([1_000]);
    const refused = (async () => { throw new Error("Attachments must be 50 MB or smaller."); }) as never;
    await expect(storeWithRetry(refused, { scope: SCOPE, name: "a.bin", mimeType: "", size: 1 }, async () => new Uint8Array(1), wait)).rejects.toThrow(/50 MB/u);
    expect(waits).toEqual([1_000]);
  });

  it("reads a file query's line range", () => {
    expect(parseFileQuery("src/a.ts")).toEqual({ path: "src/a.ts" });
    expect(parseFileQuery("src/a.ts:12")).toEqual({ path: "src/a.ts", startLine: 12 });
    expect(parseFileQuery("a.ts:9-3")).toEqual({ path: "a.ts", startLine: 9 });
  });
});
