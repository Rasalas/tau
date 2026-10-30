import { mkdtemp, readFile, readdir, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPreviewReader, readPreviewBytes, runPreviewWorker } from "./preview-host.js";
import { DOCX, zipFixture } from "./preview-fixtures.js";
import { PREVIEW_MAX_BYTES } from "./passive-preview.js";
import { bundleHostExtension } from "../../src/main/test-support/extension-bundle.js";

const roots: string[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function project() { const root = await mkdtemp(join(tmpdir(), "tau-preview-test-")); roots.push(root); return root; }

describe("machine-side passive previews", () => {
  it("runs the parser in a disposable worker and never extracts package files", async () => {
    const root = await project(); await writeFile(join(root, "a.docx"), zipFixture(DOCX));
    const reader = createPreviewReader();
    try {
      expect(await reader.read(root, "a.docx")).toMatchObject({ ok: true, content: { kind: "document" } });
      expect(await readdir(root)).toEqual(["a.docx"]);
    } finally { reader.dispose(); }
  });
  it("refuses traversal, external absolute paths, escaping symlinks and files over the read budget", async () => {
    const root = await project(); const outside = await project();
    await writeFile(join(outside, "secret"), "secret"); await symlink(join(outside, "secret"), join(root, "escape.docx"));
    for (const path of ["../secret", join(outside, "secret"), "escape.docx"]) await expect(readPreviewBytes(root, path)).rejects.toThrow(/inside the workspace/u);
    await writeFile(join(root, "large.zip"), ""); await truncate(join(root, "large.zip"), PREVIEW_MAX_BYTES + 1);
    expect(await readPreviewBytes(root, "large.zip")).toBeUndefined();
    expect(await createPreviewReader().read(root, "large.zip")).toMatchObject({ ok: false, reason: "size" });
  });
  it("reads an absolute transcript path only inside its explicitly admitted workspace", async () => {
    const root = await project();
    const path = join(root, "a.docx");
    await writeFile(path, zipFixture(DOCX));
    const reader = createPreviewReader();
    try { expect(await reader.read(root, path)).toMatchObject({ ok: true, content: { kind: "document" } }); }
    finally { reader.dispose(); }
  });
  it("checks a .db header before SQLite and reads only a bounded private snapshot", async () => {
    const root = await project(); const path = join(root, "a.db");
    const db = new DatabaseSync(path);
    db.exec("CREATE TABLE items (id INTEGER, value TEXT, payload BLOB); CREATE VIEW saved_view AS SELECT * FROM items;");
    const insert = db.prepare("INSERT INTO items VALUES (?, ?, ?)");
    for (let index = 0; index < 205; index++) insert.run(index, index === 0 ? "saved" : "x".repeat(2000), Buffer.from([1, 2]));
    db.close();
    const before = await readFile(path); const reader = createPreviewReader();
    try {
      const result = await reader.read(root, "a.db", "items");
      expect(result.ok).toBe(true);
      if (result.ok && result.content.kind === "database") {
        expect(result.content.rows).toHaveLength(200); expect(result.content.rows[0]).toEqual(["0", "saved", "BLOB · 2 B"]);
        expect(result.content.rows[1]?.[1]).toHaveLength(1024);
        expect(result.notices.some((notice) => notice.includes("200 rows"))).toBe(true);
      }
      expect(await reader.read(root, "a.db", "saved_view")).toMatchObject({ ok: true, content: { rows: [], selected: "saved_view" }, notices: [expect.stringContaining("without executing stored SQL")] });
      expect(await reader.read(root, "a.db", 'items"; DROP TABLE items;--')).toMatchObject({ ok: true, content: { selected: "items" } });
      expect(await readFile(path)).toEqual(before); expect((await readdir(root)).sort()).toEqual(["a.db"]);
      await writeFile(join(root, "opaque.db"), "not SQLite"); expect(await reader.read(root, "opaque.db")).toMatchObject({ ok: false, reason: "unsupported" });
    } finally { reader.dispose(); }
  });
  it("reads a notebook beyond the old text budget and returns parsed data", async () => {
    const root = await project(); const reader = createPreviewReader();
    const source = JSON.stringify({ nbformat: 4, cells: [{ cell_type: "markdown", source: "# Saved title" }] }).padEnd(2 * 1024 * 1024, " ");
    await writeFile(join(root, "a.ipynb"), source);
    try { expect(await reader.notebook(root, "a.ipynb")).toMatchObject({ ok: true, cells: [{ source: "# Saved title" }] }); }
    finally { reader.dispose(); }
  });
  it("terminates a parser at its deadline and allows the next worker", async () => {
    vi.useFakeTimers();
    const pending = runPreviewWorker("() => { while (true) {} }", null);
    const failure = expect(pending).rejects.toThrow("took too long");
    await vi.advanceTimersByTimeAsync(3001);
    await failure;
    vi.useRealTimers();
    expect(await runPreviewWorker("() => 42", null)).toBe(42);
  });
  it("keeps serialized worker programs usable in the shipped CommonJS host bundle", async () => {
    const root = await project(); await writeFile(join(root, "a.docx"), zipFixture(DOCX));
    const bundle = await bundleHostExtension(join(import.meta.dirname, "host.ts"));
    const file = join(root, "host.cjs"); await writeFile(file, bundle);
    const loaded = createRequire(import.meta.url)(file) as { default: () => { activate(context: unknown): (() => void) | undefined } };
    const commands = new Map<string, (input: unknown) => Promise<unknown>>();
    const dispose = loaded.default().activate({ registerMachineRouting() {}, registerCommand(name: string, run: (input: unknown) => Promise<unknown>) { commands.set(name, run); }, services: { knownWorkspacePath: async () => root } });
    try {
      expect(await commands.get("preview")!({ workspace: root, relPath: "a.docx" })).toMatchObject({ ok: true, content: { kind: "document" } });
      await writeFile(join(root, "a.ipynb"), '{"nbformat":4,"cells":[]}');
      expect(await commands.get("notebook")!({ workspace: root, relPath: "a.ipynb" })).toMatchObject({ ok: true, cells: [] });
    } finally { dispose?.(); }
  });
});

it("queues concurrent file and notebook reads instead of refusing a restored tab", async () => {
  const root = await project(); const reader = createPreviewReader();
  await writeFile(join(root, "a.docx"), zipFixture(DOCX));
  await writeFile(join(root, "a.ipynb"), '{"nbformat":4,"cells":[]}');
  try { expect(await Promise.all([reader.read(root, "a.docx"), reader.notebook(root, "a.ipynb")])).toMatchObject([{ ok: true }, { ok: true }]); }
  finally { reader.dispose(); }
});
it("never executes virtual tables after exhausting the schema display budget", async () => {
  const root = await project(); const path = join(root, "budget.db"); const db = new DatabaseSync(path);
  for (let i = 0; i < 26; i++) db.exec(`CREATE TABLE a${String(i).padStart(2, "0")}(value TEXT DEFAULT '${"x".repeat(9000)}')`);
  db.exec("CREATE VIEW v_source AS SELECT abs(-9223372036854775808) AS value; CREATE VIRTUAL TABLE z_fts USING fts5(value,content='v_source');"); db.close();
  const reader = createPreviewReader();
  try { expect(await reader.read(root, "budget.db", "z_fts")).toMatchObject({ ok: true, content: { selected: "z_fts", rows: [] }, notices: expect.arrayContaining([expect.stringContaining("without executing stored SQL")]) }); }
  finally { reader.dispose(); }
});
