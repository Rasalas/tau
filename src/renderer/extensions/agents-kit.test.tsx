// @vitest-environment jsdom
import { cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { UiSession } from "../../shared/contracts";
import { AGENTS_HOST_EXTENSION_ID, type AgentsState } from "../../shared/agents-kit-protocol";
import { setHostClient } from "../host-client-context";
import { setClientStorage } from "../client-storage";
import { createFakeHostClient } from "../test-support/fake-host-client";
import { renderApp } from "../test-support/render-app";
import { workspaceHostStub } from "../test-support/workspace-host-stub";
import { AGENT_MARKER, lineageOf } from "./agents-kit";
import { nestThreads } from "./project-navigation";

// jsdom gives the scroll rail no height, so the real virtualizer renders no
// row at all. This test is about which rows the navigator builds, not about
// how few of them it draws.
vi.mock("@tanstack/react-virtual", () => ({
  defaultRangeExtractor: (range: { startIndex: number; endIndex: number }) =>
    Array.from({ length: range.endIndex - range.startIndex + 1 }, (_, offset) => range.startIndex + offset),
  useVirtualizer: ({ count, getItemKey }: { count: number; getItemKey?: (index: number) => string | number }) => ({
    getTotalSize: () => count * 94,
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, key: getItemKey?.(index) ?? index, start: index * 94, size: 94 })),
    measureElement: () => undefined,
    scrollToIndex: () => undefined,
    scrollToOffset: () => undefined,
  }),
}));

afterEach(() => { cleanup(); setHostClient(undefined); setClientStorage(undefined); });

function session(id: string, title: string, modifiedAt: number): UiSession {
  return {
    id,
    path: `/sessions/${id}.jsonl`,
    title,
    modifiedAt,
    projectPath: "/project",
    projectName: "project",
    messageCount: 1,
  };
}

const state: AgentsState = {
  links: [
    { threadId: "alpha", parentThreadId: "parent", spawnedBy: "tau_spawn_thread", spawnedAt: 1, projectPath: "/project", depth: 1, title: "ALPHA", status: "running" },
    { threadId: "beta", parentThreadId: "parent", spawnedBy: "tau_spawn_thread", spawnedAt: 2, projectPath: "/project", depth: 1, title: "BETA", status: "completed" },
  ],
};

describe("Agents Kit lineage", () => {
  it("turns spawned threads into parents, markers and a working count", () => {
    expect(lineageOf(state)).toEqual({
      parents: { alpha: "parent", beta: "parent" },
      markers: { alpha: AGENT_MARKER, beta: AGENT_MARKER },
      workingChildren: { parent: 1 },
    });
    expect(lineageOf({ links: [{ ...state.links[1]!, status: "waiting" }] }).workingChildren).toEqual({ parent: 1 });
  });

  it("places children under their parent and leaves an orphan at the top", () => {
    const threads = [session("beta", "BETA", 3), session("parent", "Parent", 2), session("alpha", "ALPHA", 1)];
    expect(nestThreads(threads, { alpha: "parent", beta: "parent" }).map((row) => [row.session.id, row.depth]))
      .toEqual([["parent", 0], ["beta", 1], ["alpha", 1]]);
    expect(nestThreads(threads, { alpha: "gone" }).map((row) => [row.session.id, row.depth]))
      .toEqual([["beta", 0], ["parent", 0], ["alpha", 0]]);
    // A link that loops must still list both threads exactly once.
    expect(nestThreads(threads, { alpha: "beta", beta: "alpha" }).map((row) => row.session.id).sort())
      .toEqual(["alpha", "beta", "parent"]);
  });
});

describe("the navigator with spawned threads", () => {
  it("nests them under the thread that spawned them, marked and counted", async () => {
    const client = createFakeHostClient({
      bootstrap: async () => ({
        version: 1,
        threadIndex: {
          projects: [{ path: "/project", name: "project", lastOpenedAt: 3 }],
          sessions: [session("parent", "Parent thread", 3), session("alpha", "ALPHA", 2), session("beta", "BETA", 1)],
        },
        detail: { sessionId: "parent", messages: [], isStreaming: false, activeTools: [] },
        catalog: { sessionId: "parent", models: [], thinkingLevel: "off", thinkingLevels: ["off"], allTools: [], extensionCount: 0, supportsImageInput: true },
        project: { cwd: "/project" },
      }),
      invokeHostExtension: workspaceHostStub({}, {
        [AGENTS_HOST_EXTENSION_ID]: async (command) => command === "state" ? state : undefined,
      }),
    });

    renderApp(client);
    await screen.findByRole("navigation", { name: "Threads" });

    const rowOf = (title: string) => screen.getByText(title).closest("article")!;
    await waitFor(() => expect(rowOf("ALPHA").className).toContain("nested"));

    expect(rowOf("Parent thread").className).not.toContain("nested");
    expect(rowOf("ALPHA").style.getPropertyValue("--thread-depth")).toBe("1");
    expect(rowOf("BETA").style.getPropertyValue("--thread-depth")).toBe("1");
    expect(rowOf("ALPHA").textContent).toContain(AGENT_MARKER);
    expect(rowOf("Parent thread").textContent).not.toContain(AGENT_MARKER);
    expect(screen.getByLabelText("1 sub-agent running").closest("article")).toBe(rowOf("Parent thread"));
  });
});
