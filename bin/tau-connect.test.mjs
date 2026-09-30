import { describe, it, expect } from "vitest";
import { parseConnectArgs, runConnect } from "./tau-connect.mjs";

describe("tau connect", () => {
  it("takes enrollment credentials from a protected file, never from an argument", async () => {
    const calls = []; const output = [];
    await runConnect(parseConnectArgs(["register", "--relay", "https://relay.test", "--token-file", "/secret"]), {
      session: { request: async (...args) => { calls.push(args); return { phase: "connecting" }; } }, out: (line) => output.push(line), read: () => "secret\n",
    });
    expect(calls[0][1]).toEqual([{ relay: "https://relay.test", enrollmentToken: "secret" }]);
    expect(output.join("\n")).not.toContain("secret");
    expect(() => parseConnectArgs(["register", "--relay", "https://relay.test", "--token", "secret"])).toThrow();
  });
  it("returns the host's pinned pairing offer", async () => {
    const output = [];
    await runConnect({ action: "link" }, { session: { request: async () => ({ link: "tau-connect:offer" }) }, out: (line) => output.push(line) });
    expect(output).toEqual(["tau-connect:offer"]);
  });
});
