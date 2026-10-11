// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import type { HostSnapshot, UiComposerCommand } from "../shared/contracts";
import type { NewThreadDraft } from "../workbench/draft-store";
import { createFakeHostClient } from "./test-support/fake-host-client";
import { HostClientProvider } from "./host-client-context";
import { useDraftCommands } from "./use-runtime-catalog";

const skill = (name: string): UiComposerCommand => ({ name: `skill:${name}`, source: "skill", skillCommand: `/skill:${name}` });
const reload: UiComposerCommand = { name: "reload", source: "extension" };

const snapshot = { cwd: "/a", workspaceId: "ws-a", sessionId: "s", backendKind: "pi", composerCommands: [reload, skill("alpha")] } as unknown as HostSnapshot;
const draft = (workspaceId: string): NewThreadDraft => ({ kind: "draft", draftId: "d", projectPath: `/${workspaceId}`, workspaceId, projectName: workspaceId });

function setup(client = createFakeHostClient({ composerCommands: async () => [skill("bravo")] })) {
  const wrapper = ({ children }: { children: ReactNode }) => <HostClientProvider client={client}>{children}</HostClientProvider>;
  return { client, wrapper };
}

describe("useDraftCommands", () => {
  it("lists the skills of the draft's project, never the visible thread's", async () => {
    const { client, wrapper } = setup();
    const { result } = renderHook(() => useDraftCommands(snapshot, draft("ws-b"), "pi"), { wrapper });
    // Until the host answers, no skill at all.
    expect(result.current?.composerCommands).toEqual([reload]);
    await waitFor(() => expect(result.current?.composerCommands).toEqual([reload, skill("bravo")]));
    expect(client.calls.find((call) => call.method === "composerCommands")?.args).toEqual(["pi", "ws-b"]);
  });

  it("leaves the snapshot alone for a draft of the project on screen", () => {
    const { client, wrapper } = setup();
    const { result } = renderHook(() => useDraftCommands(snapshot, draft("ws-a"), "pi"), { wrapper });
    expect(result.current).toBe(snapshot);
    expect(client.calls.some((call) => call.method === "composerCommands")).toBe(false);
  });

  it("takes everything from the host for another runtime", async () => {
    const { wrapper } = setup(createFakeHostClient({ composerCommands: async () => [skill("gamma"), { name: "other", source: "prompt" }] }));
    const { result } = renderHook(() => useDraftCommands(snapshot, draft("ws-a"), "other-runtime"), { wrapper });
    expect(result.current?.composerCommands).toEqual([]);
    await waitFor(() => expect(result.current?.composerCommands?.map((command) => command.name)).toEqual(["skill:gamma", "other"]));
  });

  it("is no draft's business once the thread exists, and shows nothing it could not read", async () => {
    const { wrapper } = setup(createFakeHostClient({ composerCommands: async () => { throw new Error("gone"); } }));
    expect(renderHook(() => useDraftCommands(snapshot, { ...draft("ws-b"), sessionId: "made" }, "pi"), { wrapper }).result.current).toBe(snapshot);
    const failing = renderHook(() => useDraftCommands(snapshot, draft("ws-b"), "pi"), { wrapper });
    await waitFor(() => expect(failing.result.current?.composerCommands).toEqual([reload]));
  });
});
