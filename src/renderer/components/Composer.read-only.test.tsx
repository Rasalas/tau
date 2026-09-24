// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostSnapshot } from "../../shared/contracts";
import { Composer } from "./Composer";
import { ComposerScopeStore } from "../../workbench/composer-scope-store";
import { ExtensionRegistry } from "../extension-system";
import { WorkbenchShellContext } from "../workbench-context";
import { HostClientProvider } from "../host-client-context";
import { createFakeHostClient } from "../test-support/fake-host-client";
import { TestProviders } from "../test-support/test-providers";

afterEach(cleanup);

const snapshot: HostSnapshot = {
  cwd: "/project", sessionId: "session", sessionTitle: "Thread", backendKind: "pi",
  models: [], thinkingLevel: "medium", thinkingLevels: ["medium"],
  messages: [], isStreaming: true, activeTools: [], allTools: [], extensionCount: 0,
};

describe("the composer on a device paired Read only", () => {
  it("says why it cannot send, instead of offering the field, Stop or the pickers", () => {
    const registry = new ExtensionRegistry();
    render(<TestProviders>
      <HostClientProvider client={createFakeHostClient({ isReadOnly: () => true })}>
        <WorkbenchShellContext.Provider value={{ registry, snapshot }}>
          <Composer
            scopeStore={new ComposerScopeStore()}
            snapshot={snapshot}
            queue={[]}
            contextBreakdown={{ system: 0, messages: 0, toolOutput: 0 }}
            textareaRef={createRef<HTMLTextAreaElement>()}
            onSubmit={vi.fn(async () => ({ accepted: true as const }))}
            onAbort={() => {}}
            onCancelQueued={() => {}}
            onSteerQueued={() => {}}
            onSetModel={() => {}}
            onSetThinking={() => {}}
            onCompactContext={() => {}}
          />
        </WorkbenchShellContext.Provider>
      </HostClientProvider>
    </TestProviders>);
    expect(screen.getByRole("note").textContent).toMatch(/paired Read only/u);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByLabelText(/Stop/u)).toBeNull();
  });
});
