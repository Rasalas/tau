import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { activateHostKit } from "../../src/main/test-support/host-kit-harness.js";
import { attachmentFolder, createComposerContextHostExtension, inside, parsePullRequests, rankFiles, safeFileName, sliceLines } from "./host.js";
import { COMPOSER_CONTEXT_ID, EMBED_TEXT_BYTES } from "./protocol.js";

const scratch: string[] = [];
afterEach(async () => { await Promise.all(scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

async function setup(findCommand: (name: string) => string | undefined = () => undefined) {
  const root = await mkdtemp(join(tmpdir(), "tau-composer-context-"));
  scratch.push(root);
  const project = join(root, "project");
  const state = join(root, "state");
  await mkdir(join(project, "src"), { recursive: true });
  await writeFile(join(project, "src", "alpha.ts"), "one\ntwo\nthree\nfour\n");
  await writeFile(join(project, "README.md"), "Banana split\n");
  await writeFile(join(project, "logo.bin"), Buffer.from([1, 0, 2]));
  const registry = await activateHostKit(createComposerContextHostExtension(), {
    cwd: () => project,
    stateDir: state,
    findCommand,
    log: () => undefined,
  });
  const invoke = (command: string, input: unknown) => registry.invoke(COMPOSER_CONTEXT_ID, command, input);
  return { invoke, project, state };
}

describe("Composer Context host", () => {
  it("stores an attachment under the thread's folder in its own state and hands back the path", async () => {
    const { invoke, state } = await setup();
    const stored = await invoke("store-attachment", { scope: "session:thread-1", name: "../../notes.txt", mimeType: "text/plain", data: Buffer.from("hello").toString("base64") }) as { path: string; size: number };
    expect(stored.size).toBe(5);
    expect(stored.path.startsWith(join(state))).toBe(true);
    expect(stored.path).toMatch(/attachments[/\\]thread-1[/\\][0-9a-f]{8}-notes\.txt$/u);
    expect(await readFile(stored.path, "utf8")).toBe("hello");
    await expect(invoke("store-attachment", { scope: "s", name: "a", mimeType: "", data: "" })).rejects.toThrow(/empty/u);
  });

  it("reads a file chip's lines inside the project and nothing outside it", async () => {
    const { invoke } = await setup();
    const results = await invoke("read-files", { files: [
      { path: "src/alpha.ts", startLine: 2, endLine: 3 },
      { path: "README.md" },
      { path: "../outside.txt" },
      { path: "logo.bin" },
      { path: "missing.ts" },
    ] });
    expect(results).toEqual([
      { path: "src/alpha.ts", text: "two\nthree" },
      { path: "README.md", text: "Banana split\n" },
      { path: "../outside.txt", error: "outside the project" },
      { path: "logo.bin", error: "binary" },
      { path: "missing.ts", error: "not found" },
    ]);
  });

  it("reads back only its own attachments, and at most 200 KB of one", async () => {
    const { invoke, project } = await setup();
    const small = await invoke("store-attachment", { scope: "session:t", name: "a.txt", mimeType: "text/plain", data: Buffer.from("tiny").toString("base64") }) as { path: string };
    const large = await invoke("store-attachment", { scope: "session:t", name: "b.txt", mimeType: "text/plain", data: Buffer.from("y".repeat(EMBED_TEXT_BYTES + 10)).toString("base64") }) as { path: string };
    const described = await invoke("describe-attachments", { paths: [small.path, large.path, join(project, "README.md")] }) as Array<{ path: string; text?: string; truncated?: boolean }>;
    expect(described[0]).toEqual({ path: small.path, text: "tiny" });
    expect(described[1]?.truncated).toBe(true);
    expect(described[1]?.text).toHaveLength(EMBED_TEXT_BYTES);
    expect(described[2]).toEqual({ path: join(project, "README.md") });
  });

  it("lists the project's files best match first, without a Git repository too", async () => {
    const { invoke } = await setup();
    expect(await invoke("list-files", { query: "alp" })).toEqual(["src/alpha.ts"]);
    expect(await invoke("list-files", { query: "" })).toEqual(expect.arrayContaining(["README.md", "src/alpha.ts"]));
  });

  it("says what to install when neither gh nor glab is there", async () => {
    const { invoke } = await setup();
    await expect(invoke("list-pull-requests", {})).rejects.toThrow(/Install gh or glab/u);
  });
});

describe("Composer Context host helpers", () => {
  it("names a thread's folder by its id, and a draft's by the draft id", () => {
    expect(attachmentFolder("session:4f1c-22")).toBe("4f1c-22");
    expect(attachmentFolder("new:/repos/tau:draft-9a")).toBe("draft-9a");
    expect(attachmentFolder("../..")).toBe("draft");
    expect(safeFileName("../../etc/passwd")).toBe("passwd");
    expect(safeFileName("")).toBe("attachment");
  });

  it("keeps paths inside their root", () => {
    expect(inside("/p", "a/b.ts")).toBe("/p/a/b.ts");
    expect(inside("/p", "../x")).toBeUndefined();
    expect(inside("/p", "/etc/passwd")).toBeUndefined();
    expect(inside("/p", "")).toBeUndefined();
  });

  it("slices lines and ranks files", () => {
    expect(sliceLines("a\nb\nc", 2)).toBe("b");
    expect(sliceLines("a\nb\nc", 2, 9)).toBe("b\nc");
    expect(rankFiles(["docs/alpha-notes.md", "src/alpha.ts", "lib/xalpha.ts"], "alpha")).toEqual(["src/alpha.ts", "docs/alpha-notes.md", "lib/xalpha.ts"]);
  });

  it("reads gh and glab's JSON the same way", () => {
    expect(parsePullRequests("gh", JSON.stringify([{ number: 7, title: "Fix", url: "https://gh/7", headRefName: "fix", isDraft: true }])))
      .toEqual([{ number: 7, title: "Fix", url: "https://gh/7", branch: "fix", draft: true }]);
    expect(parsePullRequests("glab", JSON.stringify([{ iid: 3, title: "Feat", web_url: "https://gl/3", source_branch: "feat", draft: false }])))
      .toEqual([{ number: 3, title: "Feat", url: "https://gl/3", branch: "feat" }]);
  });
});
