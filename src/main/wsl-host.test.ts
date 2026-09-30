import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { expect, it, vi } from "vitest";
import { bootstrapWslHost, distributionCommand, listWslDistributions, resumeWslHost, wslPairingChannel } from "./wsl-host.js";

it("lists WSL quietly only on Windows, without localized headings", async () => {
  const execute = vi.fn(async () => "\uFEFFUbuntu\r\nDebian\r\nUbuntu\r\n");
  expect(await listWslDistributions({ platform: "darwin", execute })).toEqual([]);
  expect(execute).not.toHaveBeenCalled();
  expect(await listWslDistributions({ platform: "win32", execute })).toEqual(["Ubuntu", "Debian"]);
  expect(execute).toHaveBeenCalledWith(["--list", "--quiet"]);
});

it("passes distribution names as one argument, never as shell code", () => {
  expect(distributionCommand("Ubuntu $(touch bad)", "uname", ["-m"])).toEqual(["--distribution", "Ubuntu $(touch bad)", "--exec", "uname", "-m"]);
  expect(() => distributionCommand("Ubuntu\nother", "uname")).toThrow(/installed/u);
});

function channel() {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
  return child as unknown as ChildProcessWithoutNullStreams;
}
it("requests one pairing link and accepts only localhost forwarding", async () => {
  const child = channel();
  const writes: string[] = [];
  child.stdin.on("data", (chunk) => writes.push(String(chunk)));
  const pairing = wslPairingChannel(child);
  child.stdout.write('{"type":"ready"}\n');
  child.stdout.write('{"type":"link","urls":[{"url":"https://example.com/#private"},{"url":"http://127.0.0.1:7788/#private"}]}\n');
  const result = await pairing;
  expect(result.link).toBe("http://127.0.0.1:7788/#private");
  expect(JSON.parse(writes[0]!)).toMatchObject({ type: "link", access: "full" });
  result.close();
  expect(child.kill).toHaveBeenCalled();
});
it("rejects malformed or missing WSL routes before downloading", async () => {
  const prepare = vi.fn();
  await expect(bootstrapWslHost("Ubuntu", { cacheDir: "/cache", platform: "darwin", prepare })).rejects.toThrow(/Windows/u);
  await expect(bootstrapWslHost("Ubuntu", { cacheDir: "/cache", platform: "win32", execute: async () => "Debian", prepare })).rejects.toThrow(/no longer/u);
  expect(prepare).not.toHaveBeenCalled();
});
it("cancels pairing without touching the distro host", async () => {
  const child = channel();
  const abort = new AbortController();
  const result = wslPairingChannel(child, abort.signal);
  abort.abort();
  await expect(result).rejects.toThrow(/cancelled/u);
  expect(child.kill).toHaveBeenCalled();
});

it("resumes the saved distro host without downloading or returning its token", async () => {
  const execute = vi.fn(async () => "ws://127.0.0.1:47991/\n");
  expect(await resumeWslHost("Ubuntu", { execute })).toBe("http://127.0.0.1:47991/");
  expect(execute.mock.calls[0]?.[0].slice(0, 5)).toEqual(["--distribution", "Ubuntu", "--exec", "sh", "-c"]);
  await expect(resumeWslHost("Ubuntu", { execute: async () => "ws://example.com:123/" })).rejects.toThrow(/localhost/u);
});
