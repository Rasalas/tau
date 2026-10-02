// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { setHostClient } from "./host-client-context";
import { setClientStorage } from "../workbench/client-storage";
import { HostRequestError } from "../workbench/host-connection";
import { createFakeHostClient } from "./test-support/fake-host-client";
import { renderApp } from "./test-support/render-app";
import { workspaceHostStub } from "./test-support/workspace-host-stub";

afterEach(() => { cleanup(); setHostClient(undefined); setClientStorage(undefined); });

describe("issue 13 composer rejection", () => {
  // Synthetic host refusal, not evidence of the phone incident's admission cause.
  it("shows the reason inline and in the toast, retains the draft and sends only on explicit retry", async () => {
    const reason = "The runtime is not ready. Retry when it is ready.";
    let attempts = 0;
    const client = createFakeHostClient({
      platform: "darwin",
      bootstrap: async () => ({
        version: 1,
        threadIndex: {
          projects: [{ path: "/project", name: "project", lastOpenedAt: 1 }],
          sessions: [{ id: "session", path: "/session.jsonl", title: "Thread", modifiedAt: 1, projectPath: "/project", projectName: "project", messageCount: 1 }],
        },
        detail: { sessionId: "session", messages: [{ id: "user-1", role: "user", text: "previous prompt", timestamp: 1 }], isStreaming: false, activeTools: [] },
        catalog: { sessionId: "session", models: [], thinkingLevel: "off", thinkingLevels: ["off"], allTools: [], extensionCount: 0, supportsImageInput: true },
        project: { cwd: "/project" },
      }),
      sendPrompt: async () => {
        if (++attempts === 1) throw new HostRequestError(reason, "runtime-refused");
      },
      invokeHostExtension: workspaceHostStub({
        listEditors: async () => [],
        getChanges: async () => ({ files: [], added: 0, removed: 0 }),
        getWorkspaceInfo: async () => ({ root: "/project", isRepo: false, isDirty: false, worktrees: [], refs: [] }),
        getFileTree: async () => [],
      }),
    });
    const view = renderApp(client);
    await screen.findByText("previous prompt");
    const textarea = await screen.findByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "follow-up" } });
    const send = await screen.findByRole("button", { name: "Send" }) as HTMLButtonElement;
    await waitFor(() => expect(send.disabled).toBe(false));
    fireEvent.click(send);

    await waitFor(() => expect(view.container.querySelector(".composer-attachment-error")?.textContent).toBe(reason));
    await waitFor(() => expect(view.container.querySelector(".toast-body")?.textContent).toBe(reason));
    await waitFor(() => expect(textarea.value).toBe("follow-up"));
    await waitFor(() => expect(send.disabled).toBe(false));
    expect(attempts).toBe(1);
    expect(view.container.querySelectorAll(".message.user")).toHaveLength(1);

    fireEvent.click(send);
    await waitFor(() => expect(textarea.value).toBe(""));
    await waitFor(() => expect(view.container.querySelector(".composer-attachment-error")).toBeNull());
    expect(attempts).toBe(2);
    expect(client.calls.filter((call) => call.method === "sendPrompt").map((call) => call.args[0])).toEqual(["follow-up", "follow-up"]);
    await waitFor(() => expect(view.container.querySelectorAll(".message.user")).toHaveLength(2));
  });
});
