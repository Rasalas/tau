import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { showPage } from "./show.js";
import { PageStore } from "./store.js";

vi.mock("node:os", async (original) => ({
  ...await original<typeof import("node:os")>(),
  tmpdir: vi.fn(),
}));

describe("showPage file roots", () => {
  let root: string;
  let project: string;
  let temporary: string;
  let sharedTemporary: string | undefined;
  let store: PageStore;
  const threadId = "thread-1";

  beforeEach(async () => {
    // Keep the denied fixture outside both temp roots, including /tmp on Linux.
    root = await mkdtemp(join(process.cwd(), ".tau-pages-show-"));
    project = join(root, "project");
    temporary = join(root, "private-temp");
    await mkdir(project);
    await mkdir(temporary);
    vi.mocked(tmpdir).mockReturnValue(temporary);
    store = new PageStore({ directory: join(root, "state") });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    if (sharedTemporary) await rm(sharedTemporary, { recursive: true, force: true });
    sharedTemporary = undefined;
  });

  it("reads pages and images from the configured temp folder", async () => {
    await writeFile(join(temporary, "image.png"), Buffer.from([1, 2, 3]));
    await writeFile(join(temporary, "index.html"), '<h1>Private temp</h1><img src="image.png">');

    const shown = await showPage(store, { sessionId: threadId, cwd: project }, { title: "Private temp", path: join(temporary, "index.html") });

    expect(shown.notes).toEqual([]);
    expect((await store.get(threadId, shown.id))?.html).toBe('<h1>Private temp</h1><img src="data:image/png;base64,AQID">');
  });

  it.skipIf(process.platform === "win32")("reads /tmp pages and images when the configured temp folder is elsewhere", async () => {
    sharedTemporary = await mkdtemp("/tmp/tau-pages-show-");
    await writeFile(join(sharedTemporary, "image.png"), Buffer.from([1, 2, 3]));
    await writeFile(join(sharedTemporary, "index.html"), '<h1>Shared temp</h1><img src="image.png">');

    // macOS canonicalizes /tmp to /private/tmp. Either spelling must work.
    for (const directory of new Set([sharedTemporary, await realpath(sharedTemporary)])) {
      const shown = await showPage(store, { sessionId: threadId, cwd: project }, { title: "Shared temp", path: join(directory, "index.html") });
      expect(shown.notes).toEqual([]);
      expect((await store.get(threadId, shown.id))?.html).toBe('<h1>Shared temp</h1><img src="data:image/png;base64,AQID">');
    }
  });

  it.skipIf(process.platform === "win32")("refuses files outside the roots and links from /tmp that escape them", async () => {
    sharedTemporary = await mkdtemp("/tmp/tau-pages-show-");
    const outsidePage = join(root, "outside.html");
    const outsideImage = join(root, "outside.png");
    await writeFile(outsidePage, "<h1>Outside</h1>");
    await writeFile(outsideImage, Buffer.from([9]));
    await symlink(outsidePage, join(sharedTemporary, "escape.html"));
    await symlink(outsideImage, join(sharedTemporary, "escape.png"));

    for (const path of [outsidePage, join(sharedTemporary, "escape.html")]) {
      await expect(showPage(store, { sessionId: threadId, cwd: project }, { title: "Outside", path })).rejects.toThrow("outside the project and the temp folder");
    }
    const html = `<img src="${join(sharedTemporary, "escape.png")}">`;
    const shown = await showPage(store, { sessionId: threadId, cwd: project }, { title: "Outside image", html });
    expect(shown.notes).toEqual([`Could not embed: ${join(sharedTemporary, "escape.png")} (outside the project).`]);
    expect((await store.get(threadId, shown.id))?.html).toBe(html);
  });
});
