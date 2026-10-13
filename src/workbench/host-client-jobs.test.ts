import { describe, expect, it } from "vitest";
import type { HostPush, HostResponse } from "../shared/host-transport";
import { HostConnection, type HostTransport } from "./host-connection";
import { createHostClient } from "./host-client";

/** A host offering jobs, which finishes each job on the next tick. */
function jobHost(jobMethods: string[]) {
  const listeners = new Set<(push: HostPush) => void>();
  const sent: string[] = [];
  let seq = 0;
  const transport: HostTransport = {
    platform: "remote",
    request: async (method, params): Promise<HostResponse> => {
      sent.push(method === "start-job" ? `job:${String(params[0])}` : method);
      if (method === "hello") return { id: "1", result: { protocol: 1, hostVersion: "0", capabilities: ["jobs"], resync: false, missed: [], nextSeq: 1 } };
      if (method === "job-methods") return { id: "1", result: jobMethods };
      if (method === "start-job") {
        const jobId = `job-${sent.length}`;
        setTimeout(() => {
          seq += 1;
          for (const listener of listeners) listener({ seq, event: { type: "job-done", jobId, result: { via: "job" } } });
        }, 0);
        return { id: "1", result: { jobId } };
      }
      return { id: "1", result: { via: "request" } };
    },
    onPush: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
  };
  return { transport, sent };
}

async function clientOf(jobMethods: string[]) {
  const host = jobHost(jobMethods);
  const connection = new HostConnection(host.transport);
  await connection.start();
  await connection.refreshJobMethods();
  host.sent.length = 0;
  return { host, client: createHostClient(connection) };
}

describe("calls that can wait on a runtime start", () => {
  it("run as jobs where the host asks for that, so no request timeout cuts them off", async () => {
    const { host, client } = await clientOf(["new-session", "prompt", "steer", "follow-up"]);
    await expect(client.newSession("hello")).resolves.toEqual({ via: "job" });
    await client.sendPrompt("again", undefined, "s1");
    await client.steer("now", undefined, "s1");
    await client.followUp("later", undefined, "s1");
    await client.abort("s1");
    expect(host.sent).toEqual(["job:new-session", "job:prompt", "job:steer", "job:follow-up", "abort"]);
  });

  it("stay plain requests to a host that does not list them", async () => {
    const { host, client } = await clientOf([]);
    await expect(client.newSession("hello")).resolves.toEqual({ via: "request" });
    await client.sendPrompt("again", undefined, "s1");
    expect(host.sent).toEqual(["new-session", "prompt"]);
  });
});
