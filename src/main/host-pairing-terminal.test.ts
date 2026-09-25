import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import type { HostPairReply } from "../shared/pairing.js";
import { HostAccess } from "./host-access.js";
import { promptPairingsOnTerminal } from "./host-pairing-terminal.js";
import { HostTokenFile } from "./host-token.js";

const directories: string[] = [];
const accesses: HostAccess[] = [];
afterEach(async () => {
  // Letting a device in writes the store in the background.
  await Promise.all(accesses.splice(0).map((access) => access.flush().catch(() => undefined)));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function setup() {
  const directory = mkdtempSync(join(tmpdir(), "tau-terminal-pairing-"));
  directories.push(directory);
  let next = () => undefined as void;
  const access = await HostAccess.open({ tokenFile: new HostTokenFile(join(directory, "t")), storePath: join(directory, "p.json"), onChange: () => next() });
  accesses.push(access);
  const input = new PassThrough();
  const output = new PassThrough();
  let written = "";
  output.on("data", (chunk) => { written += String(chunk); });
  next = promptPairingsOnTerminal(access, { input, output });
  return { access, input, written: () => written };
}

describe("pairing on a hand-started host's terminal", () => {
  it("asks with the code and allows the device with the access typed", async () => {
    const { access, input, written } = await setup();
    const replies: HostPairReply[] = [];
    access.requestPairing({ name: "Phone" }, { address: "192.0.2.9" }, { settle: (reply) => { replies.push(reply); return true; } });
    expect(written()).toMatch(/Pairing request: Phone \(Unknown client, from 192\.0\.2\.9, without a pairing link\)/u);
    const code = access.overview().requests[0]!.verification;
    expect(written()).toContain(`Code ${code.slice(0, 3)} ${code.slice(3)}`);
    input.write("r\n");
    await expect.poll(() => replies.at(-1)?.state).toBe("approved");
    expect(access.overview().clients).toMatchObject([{ label: "Phone", access: "read-only" }]);
    await expect.poll(written).toMatch(/Allowed \(read only\)/u);
  });

  it("denies on anything but an explicit yes", async () => {
    const { access, input } = await setup();
    const replies: HostPairReply[] = [];
    access.requestPairing({}, { address: "192.0.2.9" }, { settle: (reply) => { replies.push(reply); return true; } });
    input.write("\n");
    await expect.poll(() => replies.at(-1)?.state).toBe("denied");
  });
});
