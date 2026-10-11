// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { HostSnapshot, TauConfig } from "../shared/contracts";
import { HostClientProvider } from "./host-client-context";
import { createFakeHostClient } from "./test-support/fake-host-client";
import { useOfferedRuntimes } from "./use-runtime-catalog";

afterEach(cleanup);

const snapshot = { workspaceId: "ws-a", runtimeBackends: [{ kind: "pi", label: "Pi" }, { kind: "codex", label: "Codex" }] } as unknown as HostSnapshot;

function Offered({ workspaceId }: { workspaceId: string | undefined }) {
  const offered = useOfferedRuntimes(snapshot, workspaceId);
  return <p data-testid="kinds">{offered?.runtimeBackends?.map((backend) => `${backend.kind}${backend.disabled ? ":off" : ""}`).join(",")}</p>;
}

describe("useOfferedRuntimes", () => {
  it("marks what the project of the workspace turned off, and follows a change of the host's config", async () => {
    const configs: Record<string, TauConfig> = { "ws-a": { runtimeEnabled: { codex: false } }, "ws-b": {} };
    const client = createFakeHostClient({ getConfig: async (workspaceId) => configs[workspaceId!] ?? {} });
    const view = render(<HostClientProvider client={client}><Offered workspaceId="ws-a" /></HostClientProvider>);
    expect(screen.getByTestId("kinds").textContent).toBe("pi,codex");
    await waitFor(() => expect(screen.getByTestId("kinds").textContent).toBe("pi,codex:off"));

    // Another project's draft: its own answer, not the thread's.
    view.rerender(<HostClientProvider client={client}><Offered workspaceId="ws-b" /></HostClientProvider>);
    await waitFor(() => expect(screen.getByTestId("kinds").textContent).toBe("pi,codex"));

    view.rerender(<HostClientProvider client={client}><Offered workspaceId="ws-a" /></HostClientProvider>);
    await waitFor(() => expect(screen.getByTestId("kinds").textContent).toBe("pi,codex:off"));
    configs["ws-a"] = { runtimeEnabled: { codex: true, pi: false } };
    act(() => client.emit({ type: "config-changed", kind: "config", paths: [] }));
    await waitFor(() => expect(screen.getByTestId("kinds").textContent).toBe("pi:off,codex"));
  });

  it("offers everything while no project is known", () => {
    render(<HostClientProvider client={createFakeHostClient()}><Offered workspaceId={undefined} /></HostClientProvider>);
    expect(screen.getByTestId("kinds").textContent).toBe("pi,codex");
  });
});
