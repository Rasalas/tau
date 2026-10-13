import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { gateToolCall, toolMetadataOf } from "./access/gate.js";
import { PREVIEW_TOOL_GROUP, previewTools, type PreviewToolController } from "./preview/agent-tools.js";

function sources(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return entry.name === "fixtures" ? [] : sources(path);
    return /\.tsx?$/u.test(path) && !/\.test\.tsx?$/u.test(path) ? [path] : [];
  });
}

describe("shipped tool annotations", () => {
  it("every Tau tool definition explicitly declares whether it is read-only", () => {
    const missing: string[] = [];
    let count = 0;
    for (const path of [...sources("kits"), ...sources("src/main")]) {
      const text = readFileSync(path, "utf8");
      if (!text.includes("registerTool") && !(text.includes("parameters") && text.includes("execute"))) continue;
      const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node) => {
        if (ts.isObjectLiteralExpression(node)) {
          const properties = new Map(node.properties.flatMap((property) => property.name ? [[property.name.getText(source), property] as const] : []));
          const registeredInline = ts.isCallExpression(node.parent) && ts.isPropertyAccessExpression(node.parent.expression)
            && node.parent.expression.name.text === "registerTool"
            && node.properties.some((property) => ts.isSpreadAssignment(property) && ts.isCallExpression(property.expression));
          if (registeredInline || properties.has("name") && properties.has("parameters") && properties.has("execute")) {
            count++;
            const annotation = properties.get("annotations");
            if (!annotation || !ts.isPropertyAssignment(annotation) || !ts.isObjectLiteralExpression(annotation.initializer)
              || !annotation.initializer.properties.some((property) => property.name?.getText(source) === "readOnlyHint")) {
              missing.push(`${path}: ${properties.get("name")?.getText(source) ?? "registerTool"}`);
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(count).toBeGreaterThan(50);
    expect(missing).toEqual([]);
  });

  it("carries Preview's annotations through the live registry before deferred tools load", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tau-tool-annotations-"));
    const agentDir = join(cwd, "agent");
    const settingsManager = SettingsManager.inMemory();
    try {
      const resourceLoader = new DefaultResourceLoader({
        cwd, agentDir, settingsManager,
        extensionFactories: [{ name: "tau-preview", factory: (pi) => {
          for (const tool of previewTools({} as PreviewToolController, "thread")) pi.registerTool({ ...tool, ...PREVIEW_TOOL_GROUP });
        } }],
      });
      await resourceLoader.reload();
      const { session } = await createAgentSession({ cwd, agentDir, resourceLoader, settingsManager, sessionManager: SessionManager.inMemory() });
      try {
        await session.bindExtensions({});
        expect(session.getActiveToolNames()).not.toContain("preview_download");
        const metadata = toolMetadataOf(() => session.getAllTools(), "preview_download");
        expect(metadata).toMatchObject({ origin: "tau", annotations: { readOnlyHint: false } });
        await expect(gateToolCall("read-only", "preview_download", { destination: ".tau/project.json" }, vi.fn(), vi.fn(), metadata)).resolves.toMatchObject({ block: true });
        const tools = session.getAllTools();
        expect(tools.some((tool) => tool.sourceInfo.source === "builtin")).toBe(true);
        for (const tool of tools) {
          const registeredMetadata = toolMetadataOf(() => tools, tool.name);
          if (registeredMetadata?.origin === "tau") expect(typeof registeredMetadata.annotations?.readOnlyHint, tool.name).toBe("boolean");
        }
      } finally { session.dispose(); }
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it.each(["preview_download", "preview_evaluate", "preview_click", "preview_type", "preview_press", "preview_open", "preview_navigate"])("gates the registered %s tool before execution", async (name) => {
    const tool = previewTools({} as PreviewToolController, "thread").find((candidate) => candidate.name === name)!;
    const confirm = vi.fn(async () => false);
    const metadata = { origin: "tau" as const, annotations: tool.annotations };
    await expect(gateToolCall("read-only", name, {}, confirm, vi.fn(), metadata)).resolves.toMatchObject({ block: true });
    expect(confirm).not.toHaveBeenCalled();
    await expect(gateToolCall("ask", name, {}, confirm, vi.fn(), metadata)).resolves.toMatchObject({ block: true });
    expect(confirm).toHaveBeenCalledOnce();
    confirm.mockResolvedValue(true);
    await expect(gateToolCall("ask", name, {}, confirm, vi.fn(), metadata)).resolves.toBeUndefined();
    await expect(gateToolCall("full", name, {}, confirm, vi.fn(), metadata)).resolves.toBeUndefined();
  });

  it.each(["preview_status", "preview_snapshot", "preview_screenshot", "preview_wait_for"])("keeps registered %s available to read-only threads", async (name) => {
    const tool = previewTools({} as PreviewToolController, "thread").find((candidate) => candidate.name === name)!;
    const confirm = vi.fn(async () => false);
    await expect(gateToolCall("read-only", name, {}, confirm, vi.fn(), { origin: "tau", annotations: tool.annotations })).resolves.toBeUndefined();
    expect(tool.annotations?.readOnlyHint).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });
});
