import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readBoundedImagePreview } from "./image-preview.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("readBoundedImagePreview", () => {
  it("returns bounded image data without exposing its local path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tau-image-preview-"));
    directories.push(directory);
    const path = join(directory, "preview.png");
    await writeFile(path, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    expect(await readBoundedImagePreview(path)).toEqual({
      name: "preview.png",
      dataUrl: "data:image/png;base64,iVBORw==",
    });
  });

  it("rejects non-image files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tau-image-preview-"));
    directories.push(directory);
    const path = join(directory, "secret.txt");
    await writeFile(path, "secret");
    expect(await readBoundedImagePreview(path)).toBeUndefined();
  });
});
