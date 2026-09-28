// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostSnapshot, WorkbenchActions } from "tau";
import { createFakeHostClient } from "../../src/renderer/test-support/fake-host-client.js";
import { createKitHarness, setHostClient, WorkbenchContext } from "../../src/renderer/test-support/kit-harness.js";
import { missingSettingsRows, renderKitSettingsPage } from "../../src/renderer/test-support/kit-settings-page.js";
import { EvidenceClient } from "./client.js";
import evidence from "./desktop.js";
import { EVIDENCE_CHANGED_EVENT, EVIDENCE_EXTENSION_ID, EVIDENCE_SERVICE, type EvidenceCaptureService, type EvidenceFrame, type EvidenceThread } from "./protocol.js";
import { EvidenceViewer } from "./viewer.js";

afterEach(() => { cleanup(); setHostClient(undefined); vi.useRealTimers(); });

const frame = (id: string, at: number, caption: string, source: EvidenceFrame["source"] = "preview"): EvidenceFrame => ({
  id, at, source, trigger: "action", caption, width: 960, height: 600, size: 10, thumbSize: 2, mediaType: "image/jpeg",
  ...(source === "screen" ? { app: "TextEdit" } : { url: "http://localhost:5173/" }),
});

const thread: EvidenceThread = {
  threadId: "s1",
  turns: [
    { turnId: "t1", startedAt: 1_000, endedAt: 5_000, frames: [frame("f1", 1_100, "When the turn started"), frame("f2", 2_000, "Clicked “Save”"), frame("f3", 3_000, "Pressed ⌘A", "screen")] },
    { turnId: "t2", startedAt: 10_000, frames: [frame("f4", 10_500, "Opened a page")] },
  ],
};

function host(overrides: Record<string, (input: never) => unknown> = {}) {
  const calls: Array<[string, unknown]> = [];
  const invoke = vi.fn(async (extensionId: string, command: string, input?: unknown) => {
    if (extensionId !== EVIDENCE_EXTENSION_ID) return undefined;
    calls.push([command, input]);
    const override = overrides[command];
    if (override) return override(input as never);
    if (command === "list") return thread;
    if (command === "image") return `data:image/jpeg;base64,${(input as { id: string }).id}`;
    if (command === "paused") return {};
    return undefined;
  });
  return { invoke, calls };
}

describe("Evidence rows", () => {
  it("puts each turn's pictures under its last reply, and a running turn's at the tail", async () => {
    setHostClient(createFakeHostClient());
    const { invoke } = host();
    const { registry } = createKitHarness(invoke);
    registry.activate(evidence);
    const { Component } = registry.getRegions("transcript-header").find((region) => region.id === "evidence.controller")!;
    const snapshot = {
      sessionId: "s1", isStreaming: true,
      messages: [
        { id: "u1", role: "user", text: "Change the header", timestamp: 900 },
        { id: "a1", role: "assistant", text: "Done", timestamp: 4_000 },
        { id: "u2", role: "user", text: "Open it", timestamp: 9_900 },
      ],
    } as unknown as HostSnapshot;
    const actions = new Proxy({}, { get: () => () => undefined }) as WorkbenchActions;
    render(
      <WorkbenchContext.Provider value={{ snapshot, tools: [], events: [], registry, openFile: () => undefined, applySnapshot: () => undefined, handleHostEvent: () => undefined } as never}>
        <Component snapshot={snapshot} actions={actions} />
      </WorkbenchContext.Provider>,
    );
    await waitFor(() => expect(registry.getTranscriptRows("s1")).toHaveLength(2));
    const [settled, running] = registry.getTranscriptRows("s1");
    expect(settled).toMatchObject({ id: "evidence:t1", afterMessageId: "a1" });
    expect(running).toMatchObject({ id: "evidence:t2", fallbackToTail: true });

    const card = render(<>{settled!.content}</>);
    expect(card.getByText("· 3 images · Preview, TextEdit")).toBeTruthy();
    await waitFor(() => expect(card.container.querySelectorAll("img")).toHaveLength(3));
    fireEvent.click(card.getByRole("listitem", { name: "Picture 2 of 3: Clicked “Save”" }));
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Evidence" })).toBeTruthy());
  });

  it("reads a thread again when the host says its pictures changed, and lends the service", async () => {
    const { invoke, calls } = host();
    const { registry } = createKitHarness(invoke);
    registry.activate(evidence);
    let service: EvidenceCaptureService | undefined;
    registry.activate({ id: "test.reader", name: "Reader", activate: (context) => { context.useService<EvidenceCaptureService>(EVIDENCE_SERVICE, (value) => { service = value; }); } });
    expect(await service!.list("s1")).toEqual(thread);
    const heard: string[] = [];
    service!.subscribe((threadId) => heard.push(threadId));
    act(() => { registry.dispatchExtensionEvent({ type: "extension-event", extensionId: EVIDENCE_EXTENSION_ID, name: EVIDENCE_CHANGED_EVENT, payload: { threadId: "s1" } }); });
    expect(heard).toEqual(["s1"]);
    await waitFor(() => expect(calls.filter(([command]) => command === "list")).toHaveLength(2));
    await service!.pause("s1", "Signing in");
    expect(calls).toContainEqual(["pause", { threadId: "s1", reason: "Signing in" }]);
  });
});

describe("Settings → Evidence", () => {
  it("turns capture on and off, chooses how long pictures stay, and has every searched row", async () => {
    const { registry } = createKitHarness(host().invoke);
    registry.activate(evidence);
    const page = registry.getSettingsPages().find((entry) => entry.id === "evidence")!;
    const { updates } = renderKitSettingsPage(page.Component, { host: { options: { [`${EVIDENCE_EXTENSION_ID}.screen`]: false } } });
    const screenSwitch = await screen.findByRole("switch", { name: "Pictures of the window the agent drives" });
    await waitFor(() => expect(screenSwitch.getAttribute("aria-checked")).toBe("false"));
    fireEvent.click(screenSwitch);
    await waitFor(() => expect(updates).toContainEqual({ options: { [`${EVIDENCE_EXTENSION_ID}.screen`]: true } }));
    expect(screenSwitch.getAttribute("aria-checked")).toBe("true");

    const retention = screen.getByRole("combobox", { name: "Keep pictures for" });
    expect([...(retention as HTMLSelectElement).options].map((entry) => entry.textContent)).toEqual(["3 days", "7 days", "14 days", "30 days", "90 days"]);
    fireEvent.change(retention, { target: { value: "30" } });
    await waitFor(() => expect(updates).toContainEqual({ values: { [`${EVIDENCE_EXTENSION_ID}.retention-days`]: "30" } }));
    // The privacy promise is in the head's description; the page keeps what it holds back.
    expect(page.description).toMatch(/Tau never pictures the whole screen/u);
    expect(screen.getByText(/Nothing is taken while a password field has the keyboard/u)).toBeTruthy();
    expect(missingSettingsRows(page)).toEqual([]);
  });
});

describe("EvidenceViewer", () => {
  it("steps with the arrows, jumps with Home and End, and plays to the end", async () => {
    vi.useFakeTimers();
    const { invoke } = host();
    const client = new EvidenceClient({ invoke: (command, input) => invoke(EVIDENCE_EXTENSION_ID, command, input), onEvent: () => () => undefined });
    render(<EvidenceViewer client={client} request={{ threadId: "s1", turn: thread.turns[0]!, index: 0 }} onClose={() => undefined} onDelete={() => undefined} notify={() => undefined} />);
    const dialog = screen.getByRole("dialog", { name: "Evidence" });
    expect(screen.getByText("When the turn started")).toBeTruthy();
    fireEvent.keyDown(dialog.firstElementChild!, { key: "ArrowRight" });
    expect(screen.getByText("Clicked “Save”")).toBeTruthy();
    fireEvent.keyDown(dialog.firstElementChild!, { key: "End" });
    expect(screen.getByText("Pressed ⌘A")).toBeTruthy();
    expect(screen.getByText("3 / 3")).toBeTruthy();
    fireEvent.keyDown(dialog.firstElementChild!, { key: "Home" });
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(1_200); });
    expect(screen.getByText("2 / 3")).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(1_200); });
    expect(screen.getByText("3 / 3")).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(1_200); });
    expect(screen.getByRole("button", { name: "Play" })).toBeTruthy();
  });
});
