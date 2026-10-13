import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { createExternalPrompt } from "./external-prompt.js";

vi.mock("node:os", async (original) => {
  const os = await original<typeof import("node:os")>();
  return { ...os, tmpdir: vi.fn(os.tmpdir) };
});

it.skipIf(process.platform === "win32")("gives each external prompt a private directory and file", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "tau-prompt-test-"));
  vi.mocked(tmpdir).mockReturnValue(scratch);
  try {
    const first = await createExternalPrompt("first");
    const second = await createExternalPrompt("second");
    expect(dirname(first)).not.toBe(dirname(second));
    for (const path of [first, second]) {
      expect(path.startsWith(scratch + "/")).toBe(true);
      expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
    expect(await readFile(first, "utf8")).toBe("first");
  } finally {
    vi.mocked(tmpdir).mockReset();
    await rm(scratch, { recursive: true, force: true });
  }
});
