import { describe, expect, it } from "vitest";
import { CLIENT_SIDE_METHODS } from "../shared/host-transport";
import { HostConnection, type HostTransport } from "./host-connection";
import { createHostClient } from "./host-client";

/** Records what each side was asked for, so the routing is visible in one list. */
function recordingTransport(name: string, log: string[]): HostTransport {
  return {
    platform: name,
    request: async (method) => {
      log.push(`${name}:${method}`);
      return { id: "1", result: method === "copy-thread-markdown" ? "# thread" : undefined };
    },
    onPush: () => () => undefined,
  };
}

describe("a client with a host in another process", () => {
  const split = () => {
    const log: string[] = [];
    const host = new HostConnection(recordingTransport("host", log));
    const local = new HostConnection(recordingTransport("local", log));
    return { log, client: createHostClient(host, local) };
  };

  it("answers the client-side methods on its own machine", async () => {
    const { log, client } = split();
    await client.copyText("x");
    await client.copyImage("data:image/png;base64,x");
    await client.readImagePreview("/tmp/a.png");
    await client.workbenchSource();
    expect(log).toEqual(["local:copy-text", "local:copy-image", "local:read-image-preview", "local:workbench-source"]);
  });

  it("sends everything else to the host", async () => {
    const { log, client } = split();
    await client.sendPrompt("hello");
    await client.listHostExtensions();
    expect(log).toEqual(["host:prompt", "host:host-extensions"]);
  });

  it("exports the thread on the host and copies it on the client", async () => {
    const { log, client } = split();
    await client.copyThreadMarkdown();
    expect(log).toEqual(["host:copy-thread-markdown", "local:copy-text"]);
  });

  it("keeps one connection when there is no separate client side", async () => {
    const log: string[] = [];
    const client = createHostClient(new HostConnection(recordingTransport("host", log)));
    await client.copyText("x");
    expect(log).toEqual(["host:copy-text"]);
  });

  it("reports the version each side said hello with", async () => {
    const hello = (version: string): HostTransport => ({
      platform: version,
      request: async () => ({ id: "1", result: { protocol: 1, hostVersion: version, capabilities: [], resync: false, missed: [], nextSeq: 1 } }),
      onPush: () => () => undefined,
    });
    const host = new HostConnection(hello("0.4.0"));
    const local = new HostConnection(hello("0.4.1"));
    const client = createHostClient(host, local);
    let heard = 0;
    client.onVersions(() => { heard += 1; });
    expect(client.getVersions()).toEqual({ host: undefined, window: undefined });
    await host.start();
    await local.start();
    expect(client.getVersions()).toEqual({ host: "0.4.0", window: "0.4.1" });
    expect(heard).toBe(2);
    expect(createHostClient(host).getVersions()).toEqual({ host: "0.4.0", window: undefined });
  });

  it("reports the platform of its own machine, not the socket's", () => {
    expect(split().client.platform).toBe("local");
    expect(createHostClient(new HostConnection(recordingTransport("host", []))).platform).toBe("host");
  });

  it("routes every client-side method name", () => {
    expect([...CLIENT_SIDE_METHODS]).toContain("desktop-extensions");
  });
});
