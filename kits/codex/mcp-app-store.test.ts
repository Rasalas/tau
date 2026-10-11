import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { McpAppStore, clipToolResult, type McpAppMeta } from "./mcp-app-store.js";
import { readAppDocument } from "./mcp-app-document.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

async function setup(limits?: ConstructorParameters<typeof McpAppStore>[0]["limits"]) {
  const directory = await mkdtemp(join(tmpdir(), "tau-mcp-apps-"));
  directories.push(directory);
  let clock = 0;
  return { directory, store: new McpAppStore({ directory, now: () => ++clock, ...(limits ? { limits } : {}) }) };
}

const meta = (extra: Partial<Omit<McpAppMeta, "capturedAt">> = {}): Omit<McpAppMeta, "capturedAt"> => ({ server: "s", tool: "t", resourceUri: "ui://s/a.html", toolInput: { a: 1 }, ...extra });

describe("McpAppStore", () => {
  it("keeps the raw document and the call apart and reads them back", async () => {
    const { store, directory } = await setup();
    await store.save("thread-1", "item-1", { html: "<p>raw</p>", meta: meta({ prefersBorder: true, toolResult: { content: [{ type: "text", text: "x" }] } }) });
    expect(await readFile(join(directory, "thread-1", "item-1.html"), "utf8")).toBe("<p>raw</p>");
    expect(await store.load("thread-1", "item-1")).toEqual({ html: "<p>raw</p>", meta: { ...meta({ prefersBorder: true, toolResult: { content: [{ type: "text", text: "x" }] } }), capturedAt: 1 } });
    expect(await store.meta("thread-1", "missing")).toBeUndefined();
  });

  it("names unsafe ids by hash so no id leaves the thread's folder", async () => {
    const { store, directory } = await setup();
    await store.save("../../escape", "../item", { html: "x", meta: meta() });
    expect(await store.meta("../../escape", "../item")).toBeDefined();
    const folders = await readdir(directory);
    expect(folders).toHaveLength(1);
    expect(folders[0]).toMatch(/^[0-9a-f]{40}$/u);
  });

  it("refuses a document over the limit and leaves nothing behind", async () => {
    const { store, directory } = await setup({ htmlBytes: 10 });
    await expect(store.save("t", "i", { html: "x".repeat(11), meta: meta() })).rejects.toThrow("too large");
    expect(await readdir(directory)).toEqual([]);
  });

  it("evicts the oldest apps past the count and the byte limit, never the one just saved", async () => {
    const { store } = await setup({ appsPerThread: 2 });
    for (const id of ["a", "b", "c"]) await store.save("t", id, { html: id, meta: meta() });
    expect(await store.meta("t", "a")).toBeUndefined();
    expect(await store.meta("t", "b")).toBeDefined();
    expect(await store.meta("t", "c")).toBeDefined();
    const bytes = await setup({ bytesPerThread: 1_500 });
    await bytes.store.save("t", "old", { html: "o".repeat(900), meta: meta() });
    await bytes.store.save("t", "new", { html: "n".repeat(900), meta: meta() });
    expect(await bytes.store.meta("t", "old")).toBeUndefined();
    expect(await bytes.store.html("t", "new")).toBe("n".repeat(900));
  });

  it("clips a huge result by dropping structuredContent whole, and a huge input", async () => {
    const { store } = await setup({ resultBytes: 200 });
    const big = { content: [{ type: "text", text: "ok" }], structuredContent: { blob: "x".repeat(500) }, isError: false };
    await store.save("t", "i", { html: "x", meta: meta({ toolResult: big, toolInput: { blob: "y".repeat(500) } }) });
    const saved = await store.meta("t", "i");
    expect(saved?.toolResult).toEqual({ content: [{ type: "text", text: "ok" }], isError: false });
    expect(saved?.toolInput).toEqual({});
    expect(clipToolResult({ content: ["z".repeat(500)], structuredContent: 1, isError: true }, 100)).toEqual({ content: [], isError: true });
  });

  it("serializes writes of one thread and leaves no temporary files", async () => {
    const { store, directory } = await setup();
    await Promise.all(Array.from({ length: 10 }, (_, index) => store.save("t", `i${index}`, { html: `h${index}`, meta: meta() })));
    const names = await readdir(join(directory, "t"));
    expect(names.filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(names.filter((name) => name.endsWith(".json"))).toHaveLength(10);
  });

  it("sweeps leftovers of a write that died and ignores a document without metadata", async () => {
    const { store, directory } = await setup();
    await store.save("t", "kept", { html: "k", meta: meta() });
    await writeFile(join(directory, "t", "half.html"), "orphan");
    await writeFile(join(directory, "t", "kept.json.abc.tmp"), "partial");
    await store.save("t", "next", { html: "n", meta: meta() });
    expect((await readdir(join(directory, "t"))).sort()).toEqual(["kept.html", "kept.json", "next.html", "next.json"]);
    expect(await store.load("t", "half")).toBeUndefined();
  });

  it("forgets a thread's folder and nothing else", async () => {
    const { store } = await setup();
    await store.save("a", "i", { html: "x", meta: meta() });
    await store.save("b", "i", { html: "x", meta: meta() });
    await store.writeContexts("a", { i: 1 });
    await store.forgetThread("a");
    expect(await store.meta("a", "i")).toBeUndefined();
    expect(await store.readContexts("a")).toBeUndefined();
    expect(await store.meta("b", "i")).toBeDefined();
  });
});

describe("readAppDocument", () => {
  const entry = (extra: Record<string, unknown> = {}) => ({ uri: "ui://s/a.html", mimeType: "text/html;profile=mcp-app", text: "<p>a</p>", ...extra });

  it("reads the policy, permissions and border the resource declared", () => {
    const result = readAppDocument({ contents: [entry({ _meta: { ui: { csp: { connectDomains: ["https://api.example.com"], resourceDomains: ["javascript:alert(1)"] }, permissions: { camera: {}, usb: {} }, prefersBorder: false } } })] }, "ui://s/a.html");
    expect(result).toEqual({ document: { html: "<p>a</p>", csp: { connectDomains: ["https://api.example.com"] }, permissions: { camera: {} }, prefersBorder: false } });
  });

  it("takes the media type with whitespace and case ignored and ignores anything else", () => {
    expect(readAppDocument({ contents: [entry({ mimeType: "Text/HTML; Profile=MCP-App" })] }, "ui://s/a.html")).toMatchObject({ document: { html: "<p>a</p>" } });
    expect(readAppDocument({ contents: [entry({ mimeType: "text/html" })] }, "ui://s/a.html")).toHaveProperty("reason");
    expect(readAppDocument({ contents: [entry({ uri: "ui://s/other.html" })] }, "ui://s/a.html")).toHaveProperty("reason");
    expect(readAppDocument({ contents: [] }, "ui://s/a.html")).toHaveProperty("reason");
    expect(readAppDocument({ contents: [entry({ text: "  " })] }, "ui://s/a.html")).toHaveProperty("reason");
  });

  it("decodes a base64 blob, and checks sizes before it decodes", () => {
    const blob = Buffer.from("<b>blob</b>").toString("base64");
    expect(readAppDocument({ contents: [{ ...entry({ blob }), text: undefined }] }, "ui://s/a.html")).toMatchObject({ document: { html: "<b>blob</b>" } });
    const huge = "A".repeat(1_000);
    const decoded: string[] = [];
    const original = Buffer.from.bind(Buffer);
    const spy = (...args: unknown[]) => { decoded.push(String(args[1])); return (original as (...a: unknown[]) => Buffer)(...args); };
    Buffer.from = spy as unknown as typeof Buffer.from;
    try {
      expect(readAppDocument({ contents: [{ ...entry({ blob: huge }), text: undefined }] }, "ui://s/a.html", 100)).toEqual({ reason: "The app's document is too large." });
    } finally { Buffer.from = original; }
    expect(decoded).toEqual([]);
    expect(readAppDocument({ contents: [entry({ text: "x".repeat(101) })] }, "ui://s/a.html", 100)).toEqual({ reason: "The app's document is too large." });
    expect(readAppDocument({ contents: [entry({ text: "é".repeat(60) })] }, "ui://s/a.html", 100)).toEqual({ reason: "The app's document is too large." });
  });
});
