import { describe, expect, it } from "vitest";
import { createDemoHost } from "./demo-host";

describe("the local demo host", () => {
  it("opens sample threads and keeps new messages only in this demo", async () => {
    const demo = createDemoHost();
    await demo.start();
    const initial = await demo.client.bootstrap();
    expect(initial.threadIndex.sessions).toHaveLength(3);
    const result = await demo.client.switchSession("demo-pagination");
    expect(result.updates.find((update) => update.type === "thread-detail")).toMatchObject({ detail: { sessionId: "demo-pagination" } });
    await demo.client.sendPrompt("a private sample message", [], "demo-pagination");
    const changed = await demo.client.bootstrap();
    expect(changed.detail.messages.at(-1)?.text).toContain("Simulated reply");
    expect(changed.detail.messages.at(-2)?.text).toBe("a private sample message");
    const fresh = createDemoHost();
    await fresh.start();
    expect(JSON.stringify(await fresh.client.bootstrap())).not.toContain("a private sample message");
  });

  it("refuses real tools and credentials instead of pretending to execute them", async () => {
    const { client, start } = createDemoHost();
    await start();
    await expect(client.runShellAction("touch /tmp/should-not-exist")).rejects.toThrow("needs a paired Tau host");
    await expect(client.invokeHostExtension("tau.push", "register", { token: "example" })).rejects.toThrow("needs a paired Tau host");
    expect(client.hasCapability("local-files")).toBe(false);
  });
});
