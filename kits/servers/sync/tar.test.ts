import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parsePax, readTar, TarError, type TarEntry } from "./tar";

const hasTar = process.platform !== "win32" && spawnSync("tar", ["--version"], { stdio: "ignore" }).status === 0;

async function* chunks(data: Buffer, size: number): AsyncGenerator<Buffer> {
  for (let start = 0; start < data.length; start += size) yield data.subarray(start, start + size);
}

async function entries(data: Buffer, size = 4096): Promise<TarEntry[]> {
  const out: TarEntry[] = [];
  for await (const entry of readTar(chunks(data, size))) out.push(entry);
  return out;
}

const LONG = `${"deep/".repeat(30)}file-with-a-name-longer-than-one-hundred-bytes.txt`;

describe.skipIf(!hasTar)("readTar on what the machine's tar writes", () => {
  let dir: string;
  let archive: Buffer;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "tau-tar-"));
    writeFileSync(join(dir, "a.txt"), "alpha\n");
    writeFileSync(join(dir, "empty"), "");
    writeFileSync(join(dir, "run.sh"), "#!/bin/sh\n", { mode: 0o755 });
    writeFileSync(join(dir, "big.bin"), Buffer.alloc(70_000, 7));
    mkdirSync(join(dir, ...LONG.split("/").slice(0, -1)), { recursive: true });
    writeFileSync(join(dir, LONG), "long");
    writeFileSync(join(dir, "ümlaut ä.txt"), "u");
    symlinkSync("a.txt", join(dir, "link"));
    utimesSync(join(dir, "a.txt"), 1_700_000_000, 1_700_000_000);
    const list = ["./a.txt", "./empty", "./run.sh", "./big.bin", `./${LONG}`, "./ümlaut ä.txt", "./link"].join("\0");
    // Two archives back to back, as xargs gives when it starts tar twice.
    const first = spawnSync("sh", ["-c", "COPYFILE_DISABLE=1 xargs -0 tar -cf -"], { cwd: dir, input: `${list}\0` });
    const second = spawnSync("sh", ["-c", "COPYFILE_DISABLE=1 tar -cf - ./a.txt"], { cwd: dir });
    archive = Buffer.concat([first.stdout, second.stdout]);
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("yields each regular file with its content, mode and mtime; links come without data", async () => {
    const found = await entries(archive);
    const files = found.filter((entry) => entry.type === "file");
    const byName = new Map(files.map((entry) => [entry.name.replace(/^\.\//u, ""), entry]));
    expect(byName.get("a.txt")).toMatchObject({ size: 6, mtime: 1_700_000_000 });
    expect(byName.get("a.txt")!.data.toString()).toBe("alpha\n");
    expect(byName.get("empty")!.data.length).toBe(0);
    expect(byName.get("run.sh")!.mode & 0o111).not.toBe(0);
    expect(byName.get("big.bin")!.data.equals(Buffer.alloc(70_000, 7))).toBe(true);
    expect(byName.get(LONG)!.data.toString()).toBe("long");
    expect(byName.get("ümlaut ä.txt")!.data.toString()).toBe("u");
    expect(found.find((entry) => entry.name.endsWith("link"))).toMatchObject({ type: "other", data: Buffer.alloc(0) });
    // The second archive after the first one's end blocks.
    expect(files.filter((entry) => entry.name.endsWith("a.txt") && !entry.name.includes("deep"))).toHaveLength(2);
  });

  it("reads the same whatever the chunks look like", async () => {
    const names = (list: TarEntry[]) => list.map((entry) => `${entry.name}:${entry.size}`);
    expect(names(await entries(archive, 97))).toEqual(names(await entries(archive, 65_536)));
  });

  it("refuses a damaged header and a stream cut in the middle", async () => {
    const damaged = Buffer.from(archive);
    damaged[10] = damaged[10]! ^ 0xff;
    await expect(entries(damaged)).rejects.toBeInstanceOf(TarError);
    await expect(entries(archive.subarray(0, 700))).rejects.toThrow(/ended in the middle/u);
  });
});

describe("parsePax", () => {
  it("reads length-prefixed records, UTF-8 and all", () => {
    const record = (key: string, value: string) => {
      const body = ` ${key}=${value}\n`;
      let length = Buffer.byteLength(body) + 2;
      if (String(length).length + Buffer.byteLength(body) !== length) length += 1;
      return `${length}${body}`;
    };
    const data = Buffer.from(record("path", "a/ä.txt") + record("mtime", "1700000000.25") + record("size", "12"));
    expect([...parsePax(data)]).toEqual([["path", "a/ä.txt"], ["mtime", "1700000000.25"], ["size", "12"]]);
  });
});
