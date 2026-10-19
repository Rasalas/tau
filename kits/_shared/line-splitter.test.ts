import { afterEach, expect, it, vi } from "vitest";
import { lineSplitter } from "./line-splitter.js";

afterEach(() => { vi.restoreAllMocks(); });

it("splits lines across chunks and drops one that grows past the limit", () => {
  const lines: string[] = [];
  const overflow = vi.fn();
  const feed = lineSplitter(8, (line) => lines.push(line), overflow);
  feed(Buffer.from("ab"));
  feed(Buffer.from("c\nlong-line-that-overflows"));
  feed(Buffer.from("-and-goes-on"));
  feed(Buffer.from("\nok\r\n"));
  expect(lines).toEqual(["abc", "ok"]);
  expect(overflow).toHaveBeenCalledTimes(1);
});

it("joins a multi-megabyte line from many chunks once, without re-reading what it holds", () => {
  const lines: string[] = [];
  const feed = lineSplitter(32 * 1024 * 1024, (line) => lines.push(line));
  const frame = JSON.stringify({ id: 1, result: { image: "x".repeat(8 * 1024 * 1024) } });
  const bytes = Buffer.from(`${frame}\n{"id":2}\n`);
  const concat = vi.spyOn(Buffer, "concat");
  const indexOf = vi.spyOn(Buffer.prototype, "indexOf");
  for (let at = 0; at < bytes.length; at += 64 * 1024) feed(bytes.subarray(at, at + 64 * 1024));
  expect(lines).toEqual([frame, '{"id":2}']);
  expect(concat).toHaveBeenCalledTimes(1);
  expect(indexOf.mock.contexts.every((searched) => (searched as Buffer).length <= 64 * 1024)).toBe(true);
});
