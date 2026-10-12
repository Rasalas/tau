// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkbenchActions } from "tau";
import { fakeGuideClient, HEAD, sampleGuide, type FakeGuideClient } from "./guide-test-support.js";
import { GuideTab, type GuideLineProps } from "./guide-tab.js";
import { guideProgress } from "./guide-tour.js";
import type { PullRequestFiles } from "./protocol.js";
import type { PullRequestClient } from "./pull-request-client.js";
import { parseGitHubDetail, parseRequestUrl, parseUnifiedDiff } from "./pull-request-json.js";
import { ALL_WRITES } from "./pull-request-writes.js";
import { TestThreadStore } from "../../src/renderer/test-support/test-providers.js";

const fixture = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");
const REF = parseRequestUrl("https://github.com/acme/tau/pull/7")!;
const DETAIL = parseGitHubDetail(REF, fixture("gh-pr-view-discussed.json"));
const ENTRIES = parseUnifiedDiff(fixture("gh-pr-diff.patch"));
const FILES: PullRequestFiles = { files: ENTRIES.map((entry) => ({ ...entry.file, viewed: "unviewed" as const })), diffs: ENTRIES.map((entry) => entry.diff), viewedOn: "host" };
const OUTPUT_TEXT = Array.from({ length: 13 }, (_unused, index) => `// source line ${index + 1}`).join("\n");

afterEach(() => {
  cleanup();
  guideProgress.clear();
  delete document.body.dataset.profile;
  vi.restoreAllMocks();
});
beforeEach(() => guideProgress.clear());

function setup(options: { guides?: FakeGuideClient; active?: boolean; files?: PullRequestFiles | undefined; filesError?: string; canFinish?: boolean } = {}) {
  const guides = options.guides ?? fakeGuideClient({ guide: sampleGuide() });
  const onSend = vi.fn();
  const onPend = vi.fn();
  const onFinish = vi.fn();
  const onOpenFile = vi.fn();
  const loadFiles = vi.fn(async () => undefined);
  const lines: GuideLineProps = {
    detail: DETAIL, threads: [], reviewComments: [], writes: ALL_WRITES,
    onComment: vi.fn(async () => undefined), onSend, onPend, onRemovePending: vi.fn(), onResolve: vi.fn(async () => undefined),
    canEdit: () => false, onEdit: vi.fn(async () => undefined),
  };
  const client = { file: vi.fn(async () => ({ text: OUTPUT_TEXT })) } as unknown as PullRequestClient;
  const actions = { activeThread: () => ({ sessionId: "thread-1", cwd: "/project", draftPending: false }), notify: vi.fn() } as unknown as WorkbenchActions;
  const files = "files" in options ? options.files : FILES;
  const ui = (active = options.active ?? true) => (
    <TestThreadStore threads={[]}>
      <GuideTab lines={lines} client={client} guides={guides} actions={actions} files={files} filesError={options.filesError} loadFiles={loadFiles} active={active} onOpenFile={onOpenFile} onFinish={options.canFinish === false ? null : onFinish} />
    </TestThreadStore>
  );
  const view = render(ui());
  return { guides, onSend, onPend, onFinish, onOpenFile, loadFiles, client, view, rerender: (active: boolean) => view.rerender(ui(active)) };
}

/** The row of a code line; the highlighter may split its text into spans, so it is read as a row. */
const findCode = (text: string) => waitFor(() => {
  const row = [...document.querySelectorAll(".diff-code")].find((element) => element.textContent?.includes(text));
  expect(row).toBeTruthy();
  return row as HTMLElement;
});

const keyDown = (key: string, init: KeyboardEventInit = {}, target: Element | Document = document.body) => fireEvent.keyDown(target, { key, ...init });

describe("the guide tab without a guide", () => {
  it("offers to write one and starts the run from the thread on screen", async () => {
    const { guides } = setup({ guides: fakeGuideClient() });
    expect(await screen.findByText("No review guide yet")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Write guide" }));
    await waitFor(() => expect(guides.write).toHaveBeenCalledWith(REF.url, { cwd: "/project", threadId: "thread-1" }));
    // The answer says a run is going: the button is a spinner and the text says the reader may leave.
    expect(await screen.findByText("Writing a review guide")).toBeTruthy();
    expect(screen.getByText(/You can leave; you will be told when it is ready/u)).toBeTruthy();
    expect((screen.getByRole("button", { name: /Reading the change/u }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows a run that is already going, and the guide when the host says it is ready", async () => {
    const { guides } = setup({ guides: fakeGuideClient({ run: { state: "running", headSha: HEAD, startedAt: "2026-10-12T10:00:00.000Z" } }) });
    expect(await screen.findByText("Writing a review guide")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Reading the change/u })).toBeTruthy();
    act(() => guides.publish({ run: null, guide: sampleGuide() }));
    expect(await screen.findByRole("heading", { name: "The output helper" })).toBeTruthy();
  });

  it("says why the last run failed and tries again", async () => {
    const { guides } = setup({ guides: fakeGuideClient({ run: { state: "failed", headSha: HEAD, failedAt: "t", detail: "Open a checkout of acme/tau first." } }) });
    expect((await screen.findByRole("alert")).textContent).toContain("Open a checkout of acme/tau first.");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(guides.write).toHaveBeenCalledTimes(1));
  });

  it("says so when the host has guides off, and when it cannot be read", async () => {
    setup({ guides: fakeGuideClient({ enabled: false }) });
    expect(await screen.findByText("Review guides are off")).toBeTruthy();
    cleanup();
    const guides = fakeGuideClient();
    guides.get.mockRejectedValueOnce(new Error("host gone"));
    setup({ guides });
    expect((await screen.findByRole("alert")).textContent).toContain("host gone");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("No review guide yet")).toBeTruthy();
  });

  it("reads no files while there is nothing to show", async () => {
    const { loadFiles } = setup({ guides: fakeGuideClient(), files: undefined });
    await screen.findByText("No review guide yet");
    expect(loadFiles).not.toHaveBeenCalled();
  });
});

describe("a guide that needs attention", () => {
  it("says it was written before the latest push, keeps the excerpts as written and offers a rewrite", async () => {
    const { guides } = setup({ guides: fakeGuideClient({ guide: sampleGuide({ headSha: "old-head" }) }) });
    expect(await screen.findByText("Written before the latest push.")).toBeTruthy();
    await findCode("return event.data.slice");
    fireEvent.click(screen.getByRole("button", { name: "Rewrite" }));
    await waitFor(() => expect(guides.write).toHaveBeenCalledWith(REF.url, { cwd: "/project", threadId: "thread-1" }));
    expect(await screen.findByText(/Rewriting this guide/u)).toBeTruthy();
    expect(screen.queryByText("Written before the latest push.")).toBeNull();
  });

  it("says a rewrite is going while the old guide stays readable", async () => {
    setup({ guides: fakeGuideClient({ guide: sampleGuide(), run: { state: "running", headSha: HEAD, startedAt: "t" } }) });
    expect(await screen.findByText(/Rewriting this guide/u)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "The output helper" })).toBeTruthy();
  });

  it("tells a failed rewrite with the stop still readable", async () => {
    setup({ guides: fakeGuideClient({ guide: sampleGuide(), run: { state: "failed", headSha: HEAD, failedAt: "t", detail: "The agent stopped." } }) });
    expect((await screen.findByRole("alert")).textContent).toContain("The agent stopped.");
    expect(screen.getByRole("heading", { name: "The output helper" })).toBeTruthy();
  });

  it("says the diff could not be loaded, and loads it again", async () => {
    const { loadFiles } = setup({ files: undefined, filesError: "rate limited" });
    expect((await screen.findByText(/excerpts are missing: rate limited/u))).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(loadFiles).toHaveBeenCalledWith(true);
  });
});

describe("the tour", () => {
  it("shows a stop: title, summary, what to look at closely, its lines, notes, files and questions", async () => {
    const { loadFiles } = setup({ files: undefined });
    expect(await screen.findByRole("heading", { name: "The output helper" })).toBeTruthy();
    await waitFor(() => expect(loadFiles).toHaveBeenCalledWith(false));
    expect(screen.getByText("byte offset").tagName).toBe("STRONG");
    const attention = screen.getByRole("complementary", { name: "Look closely" });
    expect(attention.textContent).toContain("A tradeoff to weigh");
    expect(attention.textContent).toContain("Offsets count characters, not bytes.");
    expect(screen.getByText("The overlap rule")).toBeTruthy();
    expect(screen.getByText("Stop 1 of 3")).toBeTruthy();
    const notes = screen.getByRole("region", { name: "Notes on this stop" });
    expect(within(notes).getByText("Ignores seen chunks")).toBeTruthy();
    expect(within(notes).getByText("Slices the overlap")).toBeTruthy();
    expect(within(notes).getAllByText(/^[AB]$/u).map((marker) => marker.textContent)).toEqual(["A", "B"]);
    expect(screen.getByRole("button", { name: "Open kits/package.json in Code" }).textContent).toContain("Engine bump");
    expect(screen.getByRole("button", { name: /Why not number by sequence/u })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Ask about this stop" })).toBeTruthy();
  });

  it("draws the excerpt's lines with the file's real numbers, and the note markers on the lines they mark", async () => {
    setup();
    const code = await findCode("return event.data.slice");
    expect(code.closest(".diff-stream-row")?.textContent).toContain("12");
    // Lines before the excerpt are folded behind a bar, not drawn.
    await findCode("if (event.offset <= drawn)");
    expect([...document.querySelectorAll(".diff-code")].some((element) => element.textContent?.includes("export function unseenOutput"))).toBe(false);
    const marked = document.querySelectorAll(".guide-line-notes");
    expect([...marked].map((element) => element.textContent)).toEqual(expect.arrayContaining([expect.stringContaining("Ignores seen chunks"), expect.stringContaining("Slices the overlap")]));
    expect(screen.getByRole("button", { name: "9 unchanged lines" })).toBeTruthy();
  });

  it("loads the file for the bar above an excerpt and shows the lines", async () => {
    const { client } = setup();
    fireEvent.click(await screen.findByRole("button", { name: "9 unchanged lines" }));
    expect(await screen.findByText("// source line 4")).toBeTruthy();
    expect(client.file).toHaveBeenCalledWith(REF.url, "kits/terminal/output.ts");
  });

  it("steps with J and K while the tab is on screen and never while the reader types, holds a modifier or the palette is open", async () => {
    setup();
    await screen.findByRole("heading", { name: "The output helper" });
    keyDown("j");
    expect(await screen.findByRole("heading", { name: "The docs" })).toBeTruthy();
    keyDown("k");
    expect(await screen.findByRole("heading", { name: "The output helper" })).toBeTruthy();
    keyDown("k");
    expect(screen.getByRole("heading", { name: "The output helper" })).toBeTruthy();

    const field = document.body.appendChild(document.createElement("textarea"));
    keyDown("j", {}, field);
    keyDown("j", { metaKey: true });
    keyDown("j", { shiftKey: true });
    const palette = document.body.appendChild(document.createElement("div"));
    palette.setAttribute("role", "dialog");
    palette.setAttribute("aria-modal", "true");
    keyDown("j");
    palette.remove();
    field.remove();
    expect(screen.getByRole("heading", { name: "The output helper" })).toBeTruthy();
    keyDown("j");
    expect(await screen.findByRole("heading", { name: "The docs" })).toBeTruthy();
  });

  it("does not step while another tab is on screen", async () => {
    const { rerender } = setup({ active: false });
    await screen.findByRole("heading", { name: "The output helper" });
    keyDown("j");
    expect(screen.getByRole("heading", { name: "The output helper" })).toBeTruthy();
    rerender(true);
    keyDown("j");
    expect(await screen.findByRole("heading", { name: "The docs" })).toBeTruthy();
  });

  it("goes on with Next and ends on the last stop with Finish review", async () => {
    const { onFinish } = setup();
    fireEvent.click(await screen.findByRole("button", { name: "Next: The docs" }));
    expect(await screen.findByRole("heading", { name: "The docs" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open docs/CORE.md in Code" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Previous stop" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Next: The engine" }));
    expect(await screen.findByRole("heading", { name: "The engine" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Next stop" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Finish review" }));
    expect(onFinish).toHaveBeenCalledTimes(1);
  });

  it("has no Finish review where the reader cannot review", async () => {
    setup({ canFinish: false });
    fireEvent.click(await screen.findByRole("button", { name: "Next: The docs" }));
    fireEvent.click(await screen.findByRole("button", { name: "Next: The engine" }));
    await screen.findByRole("heading", { name: "The engine" });
    expect(screen.queryByRole("button", { name: "Finish review" })).toBeNull();
  });

  it("opens a file of the stop in the Code tab", async () => {
    const { onOpenFile } = setup();
    fireEvent.click(await screen.findByRole("button", { name: "Open kits/package.json in Code" }));
    expect(onOpenFile).toHaveBeenCalledWith("kits/package.json");
    fireEvent.click(screen.getByRole("button", { name: "Open kits/terminal/output.ts in Code" }));
    expect(onOpenFile).toHaveBeenLastCalledWith("kits/terminal/output.ts");
  });

  it("hands a question, or the stop alone, to the composer as a chip", async () => {
    const { onSend } = setup();
    fireEvent.click(await screen.findByRole("button", { name: /Why not number by sequence/u }));
    expect(onSend).toHaveBeenLastCalledWith(expect.objectContaining({
      kind: "text-excerpt",
      label: "Stop 1: The output helper",
      payload: expect.objectContaining({ source: "Review guide of PR #7", text: expect.stringContaining("Question: Why not number by sequence?") }),
    }));
    const first = onSend.mock.calls[0]![0] as { payload: { text: string } };
    expect(first.payload.text).toContain("kits/terminal/output.ts:10-13");
    expect(first.payload.text).toContain("Offsets count characters, not bytes.");
    fireEvent.click(screen.getByRole("button", { name: "Ask about this stop" }));
    expect((onSend.mock.calls[1]![0] as { payload: { text: string } }).payload.text).not.toContain("Question:");
  });

  it("adds a comment on an excerpt's line to the review the Code tab collects", async () => {
    const { onPend } = setup();
    fireEvent.click(await screen.findByRole("button", { name: "Comment on line 11" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Comment on line 11" }), { target: { value: "Count bytes." } });
    fireEvent.click(screen.getByRole("button", { name: "Add to review" }));
    expect(onPend).toHaveBeenCalledWith({ path: "kits/terminal/output.ts", line: 11, side: "new", body: "Count bytes." });
  });

  it("sends a line comment to the agent instead", async () => {
    const { onSend } = setup();
    fireEvent.click(await screen.findByRole("button", { name: "Comment on line 12" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Comment on line 12" }), { target: { value: "Why slice?" } });
    fireEvent.click(screen.getByRole("button", { name: "Send to agent" }));
    expect(onSend).toHaveBeenCalledWith(expect.objectContaining({ kind: "text-excerpt", payload: expect.objectContaining({ text: expect.stringContaining("Why slice?") }) }));
  });

  it("says when an excerpt's lines are not in the loaded diff", async () => {
    const guide = sampleGuide();
    guide.stops[0]!.excerpts = [{ path: "kits/terminal/output.ts", side: "new", start: 500, end: 510, caption: "" }];
    const { onOpenFile } = setup({ guides: fakeGuideClient({ guide }) });
    expect(await screen.findByText(/Lines 500–510 of/u)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open in Code" }));
    expect(onOpenFile).toHaveBeenCalledWith("kits/terminal/output.ts");
  });

  it("says the file is loading while the diff is on its way", async () => {
    setup({ files: undefined });
    expect(await screen.findByText("Loading kits/terminal/output.ts…")).toBeTruthy();
  });
});

describe("the rail and where the reader is", () => {
  let width = 0;
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => width);
  });

  it("lists the stops beside the stop on a wide panel, marks the ones left behind and jumps on a click", async () => {
    width = 1000;
    setup();
    const rail = await screen.findByRole("navigation", { name: "Stops of the guide" });
    expect(within(rail).getAllByRole("button")).toHaveLength(3);
    expect(within(rail).getByRole("button", { name: /The output helper/u }).getAttribute("aria-current")).toBe("step");
    expect(screen.queryByRole("button", { name: /^Stop 1 of 3/u })).toBeNull();
    fireEvent.click(within(rail).getByRole("button", { name: /The engine/u }));
    expect(await screen.findByRole("heading", { name: "The engine" })).toBeTruthy();
    expect(within(rail).getByRole("button", { name: /The output helper/u }).textContent).toContain("Seen");
    expect(within(rail).getByRole("button", { name: /The docs/u }).textContent).not.toContain("Seen");
    // Going back does not mark the stop it leaves.
    fireEvent.click(within(rail).getByRole("button", { name: /The docs/u }));
    await screen.findByRole("heading", { name: "The docs" });
    expect(within(rail).getByRole("button", { name: /The engine/u }).textContent).not.toContain("Seen");
  });

  it("puts the notes in a column of their own on a very wide panel", async () => {
    width = 1500;
    setup();
    await screen.findByRole("heading", { name: "The output helper" });
    expect(document.querySelector(".guide-notes-column .guide-notes")).not.toBeNull();
    expect(screen.getAllByRole("region", { name: "Notes on this stop" })).toHaveLength(1);
  });

  it("folds the rail into a Stop n of m accordion on a narrow panel", async () => {
    width = 500;
    setup();
    const fold = await screen.findByRole("button", { name: /Stop 1 of 3/u });
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("navigation", { name: "Stops of the guide" })).toBeNull();
    fireEvent.click(fold);
    const rail = screen.getByRole("navigation", { name: "Stops of the guide" });
    fireEvent.click(within(rail).getByRole("button", { name: /The docs/u }));
    expect(await screen.findByRole("heading", { name: "The docs" })).toBeTruthy();
    // The list folds shut again after a pick.
    expect(screen.queryByRole("navigation", { name: "Stops of the guide" })).toBeNull();
  });

  it("opens the same guide in a second panel where the reader is, and starts over on a new head", async () => {
    width = 1000;
    setup();
    fireEvent.click(await screen.findByRole("button", { name: "Next: The docs" }));
    await screen.findByRole("heading", { name: "The docs" });
    cleanup();
    setup();
    expect(await screen.findByRole("heading", { name: "The docs" })).toBeTruthy();
    cleanup();
    setup({ guides: fakeGuideClient({ guide: sampleGuide({ headSha: "next-head" }), currentHeadSha: "next-head" }) });
    expect(await screen.findByRole("heading", { name: "The output helper" })).toBeTruthy();
  });
});

describe("the guide on a phone", () => {
  beforeEach(() => { document.body.dataset.profile = "compact"; });

  it("lists the stops with their marks, and Start opens the first", async () => {
    setup();
    expect(await screen.findByRole("heading", { name: "Review guide" })).toBeTruthy();
    const outline = screen.getAllByRole("listitem");
    expect(outline).toHaveLength(3);
    expect(within(outline[0]!).getByLabelText("A tradeoff to weigh")).toBeTruthy();
    expect(within(outline[0]!).getByText("2 files")).toBeTruthy();
    expect(within(outline[1]!).getByText("2 files")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(await screen.findByRole("heading", { name: "The output helper" })).toBeTruthy();
    expect(screen.getByText("Stop 1 of 3")).toBeTruthy();
    await findCode("return event.data.slice");
  });

  it("walks one screen per stop with a bar at the foot: Back, Next stop, Finish review", async () => {
    const { onFinish } = setup();
    fireEvent.click(await screen.findByRole("button", { name: "Start" }));
    await screen.findByRole("heading", { name: "The output helper" });
    fireEvent.click(screen.getByRole("button", { name: /Next stop/u }));
    expect(await screen.findByRole("heading", { name: "The docs" })).toBeTruthy();
    expect(screen.getByText("Stop 2 of 3")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Back/u }));
    expect(await screen.findByRole("heading", { name: "The output helper" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Next stop/u }));
    fireEvent.click(await screen.findByRole("button", { name: /Next stop/u }));
    expect(await screen.findByRole("heading", { name: "The engine" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Next stop/u })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Finish review/u }));
    expect(onFinish).toHaveBeenCalledTimes(1);
  });

  it("goes back to the outline from the first stop, and remembers the place", async () => {
    setup();
    fireEvent.click(await screen.findByRole("button", { name: "Start" }));
    await screen.findByRole("heading", { name: "The output helper" });
    fireEvent.click(screen.getByRole("button", { name: /Next stop/u }));
    await screen.findByRole("heading", { name: "The docs" });
    fireEvent.click(screen.getByRole("button", { name: /All stops/u }));
    fireEvent.click(await screen.findByRole("button", { name: /^Continue at stop 2/u }));
    expect(await screen.findByRole("heading", { name: "The docs" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Back/u }));
    fireEvent.click(await screen.findByRole("button", { name: /Back/u }));
    expect(await screen.findByRole("heading", { name: "Review guide" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Continue at stop 1/u }));
    expect(await screen.findByRole("heading", { name: "The output helper" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /All stops/u }));
    fireEvent.click(await screen.findByRole("button", { name: /The engine/u }));
    expect(await screen.findByRole("heading", { name: "The engine" })).toBeTruthy();
  });

  it("asks about a stop and comments on its lines as on the desktop", async () => {
    const { onSend, onPend } = setup();
    fireEvent.click(await screen.findByRole("button", { name: "Start" }));
    fireEvent.click(await screen.findByRole("button", { name: /Why not number by sequence/u }));
    expect(onSend).toHaveBeenCalledWith(expect.objectContaining({ label: "Stop 1: The output helper" }));
    fireEvent.click(await screen.findByRole("button", { name: "Comment on line 11" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Comment on line 11" }), { target: { value: "Bytes." } });
    fireEvent.click(screen.getByRole("button", { name: "Add to review" }));
    expect(onPend).toHaveBeenCalledWith({ path: "kits/terminal/output.ts", line: 11, side: "new", body: "Bytes." });
  });

  it("hides the code of a stale guide until it is rewritten but keeps titles, summaries and files", async () => {
    const { guides } = setup({ guides: fakeGuideClient({ guide: sampleGuide({ headSha: "old-head" }) }) });
    expect(await screen.findByText("Written before the latest push.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(await screen.findByRole("heading", { name: "The output helper" })).toBeTruthy();
    expect(screen.getByText(/Output is numbered by/u)).toBeTruthy();
    expect(screen.getByText(/The code is hidden until this guide is rewritten/u)).toBeTruthy();
    expect(document.querySelector(".diff-code")).toBeNull();
    expect(screen.queryByRole("region", { name: "Notes on this stop" })).toBeNull();
    expect(screen.getByRole("button", { name: "Open kits/package.json in Code" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Rewrite" }));
    await waitFor(() => expect(guides.write).toHaveBeenCalled());
  });
});
