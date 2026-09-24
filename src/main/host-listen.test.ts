import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { rememberPort, rememberedPort, stickyListen } from "./host-listen.js";

describe("stickyListen", () => {
  it("asks for the last port again while it is free, so a paired tab's address stays the same", async () => {
    const isFree = vi.fn(async () => true);
    await expect(stickyListen("127.0.0.1:0", 56998, isFree)).resolves.toBe("127.0.0.1:56998");
    expect(isFree).toHaveBeenCalledWith("127.0.0.1", 56998);
    await expect(stickyListen("::1:0", 56998, isFree)).resolves.toBe("[::1]:56998");
  });

  it("takes any port when the last one is taken or unknown, and never overrides a port asked for", async () => {
    await expect(stickyListen("127.0.0.1:0", 56998, async () => false)).resolves.toBe("127.0.0.1:0");
    await expect(stickyListen("127.0.0.1:0", undefined, async () => true)).resolves.toBe("127.0.0.1:0");
    const isFree = vi.fn(async () => true);
    await expect(stickyListen("127.0.0.1:7788", 56998, isFree)).resolves.toBe("127.0.0.1:7788");
    expect(isFree).not.toHaveBeenCalled();
  });
});

describe("rememberPort / rememberedPort", () => {
  it("keeps the bound port in a file of the host's userData", () => {
    const file = join(mkdtempSync(join(tmpdir(), "tau-port-")), "host-port");
    expect(rememberedPort(file)).toBeUndefined();
    rememberPort(file, 56998);
    expect(rememberedPort(file)).toBe(56998);
    writeFileSync(file, "not a port\n");
    expect(rememberedPort(file)).toBeUndefined();
  });
});
