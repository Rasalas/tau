import { describe, expect, it } from "vitest";
import type { HostEvent, HostExtensionSummary } from "../shared/contracts";
import { READ_ONLY_REASON } from "../shared/host-method-access";
import { HOST_ERROR, type HostPush } from "../shared/host-transport";
import { createHostClient } from "./host-client";
import { HostConnection, type HostTransport } from "./host-connection";

const hello = (access?: "read-only") => ({ protocol: 1, hostVersion: "1", capabilities: [], resync: false, missed: [], nextSeq: 1, ...(access ? { access } : {}) });

/** A host that says hello with an access level and lists `summaries`; `sent` records every other request. */
function host(access: "read-only" | undefined, summaries: () => HostExtensionSummary[]) {
  const sent: string[] = [];
  let push: ((push: HostPush) => void) | undefined;
  let seq = 0;
  const transport: HostTransport = {
    platform: "test",
    request: async (method, params) => {
      if (method === "hello") return { id: "1", result: hello(access) };
      sent.push(method === "host-extension" ? `host-extension:${String(params[0])}/${String(params[1])}` : method);
      if (method === "host-extensions") return { id: "1", result: summaries() };
      return { id: "1", result: "ran" };
    },
    onPush: (listener) => { push = listener; return () => undefined; },
  };
  const connection = new HostConnection(transport);
  const emit = (event: HostEvent) => push?.({ seq: ++seq, event } as HostPush);
  return { connection, client: createHostClient(connection), sent, emit };
}

const review: HostExtensionSummary = { id: "tau.review", name: "Review", active: true, commands: ["changes", "commit"], readCommands: ["changes"] };

describe("a device paired Read only", () => {
  it("is refused a change before anything is sent, with the reason its controls give", async () => {
    const { connection, client, sent } = host("read-only", () => [review]);
    await connection.start();
    await expect(client.sendPrompt("hi")).rejects.toMatchObject({ message: READ_ONLY_REASON, code: HOST_ERROR.forbidden });
    await expect(client.updateConfig({})).rejects.toMatchObject({ message: READ_ONLY_REASON });
    await expect(client.listConnections()).rejects.toMatchObject({ message: READ_ONLY_REASON });
    await expect(client.rebuildWorkbench()).rejects.toMatchObject({ message: READ_ONLY_REASON });
    expect(sent).toEqual([]);
    await client.loadTranscript("s1");
    expect(sent).toEqual(["transcript-page"]);
  });

  it("runs the kit commands the host lists as reads and refuses the others", async () => {
    const { connection, client, sent } = host("read-only", () => [review]);
    await connection.start();
    await expect(client.invokeHostExtension("tau.review", "changes")).resolves.toBe("ran");
    await expect(client.invokeHostExtension("tau.review", "commit")).rejects.toMatchObject({ message: READ_ONLY_REASON });
    await expect(client.invokeHostExtension("tau.other", "changes")).rejects.toMatchObject({ message: READ_ONLY_REASON });
    expect(sent).toEqual(["host-extensions", "host-extension:tau.review/changes"]);
  });

  it("tells controls once the host has said, and again when packages change", async () => {
    let summaries = [review];
    const { connection, client, emit } = host("read-only", () => summaries);
    await connection.start();
    let changes = 0;
    client.onHostCommandsChanged?.(() => { changes += 1; });
    expect(client.mayInvokeHostExtension?.("tau.review", "changes")).toBe(false);
    await expect.poll(() => changes).toBe(1);
    expect(client.mayInvokeHostExtension?.("tau.review", "changes")).toBe(true);
    expect(client.mayInvokeHostExtension?.("tau.review", "commit")).toBe(false);

    summaries = [{ ...review, readCommands: ["changes", "commit"] }];
    emit({ type: "extension-packages-changed" });
    // The old answer holds until the new one is in.
    expect(client.mayInvokeHostExtension?.("tau.review", "changes")).toBe(true);
    await expect.poll(() => changes).toBe(2);
    expect(client.mayInvokeHostExtension?.("tau.review", "commit")).toBe(true);
  });
});

describe("a device with Full access", () => {
  it("sends everything and never asks which commands only read", async () => {
    const { connection, client, sent } = host(undefined, () => [review]);
    await connection.start();
    await client.sendPrompt("hi");
    await client.invokeHostExtension("tau.review", "commit");
    expect(client.mayInvokeHostExtension?.("tau.review", "commit")).toBe(true);
    expect(sent).toEqual(["prompt", "host-extension:tau.review/commit"]);
  });
});
