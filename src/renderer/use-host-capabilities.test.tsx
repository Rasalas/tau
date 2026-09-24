// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { HostClientProvider } from "./host-client-context";
import { createFakeHostClient } from "./test-support/fake-host-client";
import { useCommandAllowed } from "./use-host-capabilities";

afterEach(cleanup);

describe("useCommandAllowed", () => {
  it("follows what the client learns about the commands a Read-only device may run", () => {
    const reads = new Set<string>();
    const listeners = new Set<() => void>();
    const client = createFakeHostClient({
      isReadOnly: () => true,
      mayInvokeHostExtension: (extensionId, command) => reads.has(`${extensionId}/${command}`),
      onHostCommandsChanged: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    });
    const wrapper = ({ children }: { children: ReactNode }) => <HostClientProvider client={client}>{children}</HostClientProvider>;
    const { result } = renderHook(() => useCommandAllowed("tau.review", "changes"), { wrapper });
    expect(result.current).toBe(false);
    act(() => {
      reads.add("tau.review/changes");
      for (const listener of listeners) listener();
    });
    expect(result.current).toBe(true);
  });

  it("falls back to the access level for a client that cannot tell commands apart", () => {
    const hook = (readOnly: boolean) => renderHook(() => useCommandAllowed("tau.review", "commit"), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <HostClientProvider client={createFakeHostClient({ isReadOnly: () => readOnly })}>{children}</HostClientProvider>
      ),
    }).result.current;
    expect(hook(true)).toBe(false);
    expect(hook(false)).toBe(true);
  });
});
