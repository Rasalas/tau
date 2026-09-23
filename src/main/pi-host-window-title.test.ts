import { describe, expect, it } from "vitest";
import type { HostEvent } from "../shared/contracts.js";
import { HostClientRegistry } from "./host-clients.js";
import { PiHost } from "./pi-host.js";

describe("the window title a Pi extension sets", () => {
  it("reaches every client as a push, and a client that attaches later hears the last one", () => {
    const events: HostEvent[] = [];
    const clients = new HostClientRegistry();
    const history = { list: () => [], isHidden: () => false };
    const host = new PiHost("/repo", (event) => { events.push(event); }, history as never, false, false, { clients });
    const titles = () => events.filter((event) => event.type === "window-title");

    clients.attached({ transport: "socket" });
    expect(titles()).toEqual([]);

    (host as unknown as { publishWindowTitle(title: string): void }).publishWindowTitle("π - repo");
    expect(titles()).toEqual([{ type: "window-title", title: "π - repo" }]);

    clients.attached({ transport: "socket" });
    expect(titles()).toEqual([{ type: "window-title", title: "π - repo" }, { type: "window-title", title: "π - repo" }]);
  });
});
