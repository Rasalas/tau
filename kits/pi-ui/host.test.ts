import { describe, expect, it, vi } from "vitest";
import type { GlobalHostEvent, HostThread, HostUiPresenter } from "tau/host-extension";
import { activateHostKit } from "../../src/main/test-support/host-kit-harness.js";
import createPiUiHostExtension from "./host.js";

function harness() {
  const events: GlobalHostEvent[] = [];
  const presenters: HostUiPresenter[] = [];
  const services = {
    log: vi.fn(),
    thread: () => ({ sessionId: "s1" }) as HostThread,
    presentUi: (presenter: HostUiPresenter) => { presenters.push(presenter); return () => undefined; },
  };
  return { services, presenters, events };
}

describe("Pi UI host half", () => {
  it("keeps statuses, widgets and the working message per thread and publishes changes", async () => {
    const { services, presenters, events } = harness();
    const registry = await activateHostKit(createPiUiHostExtension(), services, (event) => events.push(event));
    const [presenter] = presenters;
    presenter!.setStatus!("s1", "git", "main*");
    presenter!.setStatus!("s1", "vim", "NORMAL");
    presenter!.setWidget!("s1", "todo", ["[ ] tests", "[x] code"], "belowEditor");
    presenter!.setWorkingMessage!("s1", "Thinking hard");
    presenter!.setStatus!("s1", "git", undefined);
    await expect(registry.invoke("tau.pi-ui", "state")).resolves.toEqual({
      sessionId: "s1",
      statuses: [{ key: "vim", text: "NORMAL" }],
      widgets: [{ key: "todo", lines: ["[ ] tests", "[x] code"], placement: "belowEditor" }],
      working: "Thinking hard",
    });
    await expect(registry.invoke("tau.pi-ui", "state", { sessionId: "other" })).resolves.toEqual({ sessionId: "other", statuses: [], widgets: [] });
    expect(events.filter((event) => event.type === "extension-event" && event.extensionId === "tau.pi-ui")).toHaveLength(5);
    presenter!.clear!("s1");
    await expect(registry.invoke("tau.pi-ui", "state")).resolves.toEqual({ sessionId: "s1", statuses: [], widgets: [] });
    // A thread the kit has already forgotten publishes nothing a second time.
    presenter!.clear!("s1");
    expect(events).toHaveLength(6);
  });
});
