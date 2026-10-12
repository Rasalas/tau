import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Type } from "typebox";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionFactory,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createDeferredToolsExtension, TOOL_SEARCH_TOOL } from "./deferred-tools.js";

const dirs: string[] = [];
const sessions: AgentSession[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) session.dispose();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const tool = (name: string, description: string, extra: Partial<ToolDefinition> = {}): ToolDefinition => ({
  name,
  label: name,
  description,
  parameters: Type.Object({}),
  execute: async () => ({ content: [{ type: "text", text: "ok" }], details: undefined }),
  ...extra,
});

const PREVIEW = { exposure: "deferred" as const, namespace: { name: "preview", description: "Open a page in the preview and drive it." } };
const kitTools: ExtensionFactory = (pi) => {
  pi.registerTool(tool("attach_note", "Always declared."));
  pi.registerTool(tool("preview_open", "Open a URL in the preview.", PREVIEW));
  pi.registerTool(tool("preview_screenshot", "Take a screenshot of the preview page.", PREVIEW));
  pi.registerTool(tool("computer_use_click", "Click in a window.", { exposure: "deferred", namespace: { name: "computer_use", description: "Use apps on this computer." } }));
};

/** What a persona does: narrows the active tools when the session starts. */
const narrowing: ExtensionFactory = (pi) => {
  pi.on("session_start", () => { pi.setActiveTools(pi.getActiveTools().filter((name) => name !== TOOL_SEARCH_TOOL)); });
};

async function open(...factories: ExtensionFactory[]): Promise<AgentSession> {
  const dir = await mkdtemp(join(tmpdir(), "tau-deferred-tools-"));
  dirs.push(dir);
  const resourceLoader = new DefaultResourceLoader({
    cwd: dir,
    agentDir: join(dir, "agent"),
    settingsManager: SettingsManager.inMemory(),
    extensionFactories: factories.map((factory, index) => ({ name: `test-${index}`, factory })),
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({ cwd: dir, agentDir: join(dir, "agent"), resourceLoader, settingsManager: SettingsManager.inMemory(), sessionManager: SessionManager.inMemory() });
  sessions.push(session);
  await session.bindExtensions({});
  return session;
}

const searchTool = (session: AgentSession) => session.getToolDefinition(TOOL_SEARCH_TOOL)!;
const declared = (session: AgentSession) => session.agent.state.tools.find((candidate) => candidate.name === TOOL_SEARCH_TOOL)?.description ?? "";

describe("deferred kit tools", () => {
  it("keeps deferred tools out of the request until tool_search loads them", async () => {
    const session = await open(createDeferredToolsExtension(), kitTools);
    expect(session.getActiveToolNames()).toEqual(expect.arrayContaining(["attach_note", TOOL_SEARCH_TOOL]));
    expect(session.getActiveToolNames()).not.toContain("preview_open");
    expect(session.systemPrompt).not.toContain("preview_open");

    const result = await searchTool(session).execute("call-1", { query: "preview screenshot" }, undefined, undefined, undefined as never);
    expect(result.details).toMatchObject({ loaded: expect.arrayContaining(["preview_screenshot", "preview_open"]) });
    expect(session.getActiveToolNames()).toEqual(expect.arrayContaining(["preview_screenshot", "preview_open"]));
    expect(session.getActiveToolNames()).not.toContain("computer_use_click");
  });

  it("lists the groups in the search tool's own description, and only there", async () => {
    const session = await open(createDeferredToolsExtension(), kitTools);
    const description = declared(session);
    expect(description).toContain("- preview (2 tools): Open a page in the preview and drive it.");
    expect(description).toContain("- computer_use (1 tool): Use apps on this computer.");
    expect(description.match(/- preview /gu)).toHaveLength(1);
    expect(session.systemPrompt).not.toContain("computer_use");
    // Loading a group does not change what the model was told.
    await searchTool(session).execute("call-1", { query: "preview" }, undefined, undefined, undefined as never);
    expect(declared(session)).toBe(description);
  });

  it("does not switch the search on when no tool is deferred", async () => {
    const session = await open(createDeferredToolsExtension(), (pi) => { pi.registerTool(tool("attach_note", "Always declared.")); });
    expect(session.getActiveToolNames()).not.toContain(TOOL_SEARCH_TOOL);
  });

  it("lets an extension that narrows the tools drop the search, so a persona cannot reach the rest", async () => {
    const session = await open(createDeferredToolsExtension(), kitTools, narrowing);
    expect(session.getActiveToolNames()).not.toContain(TOOL_SEARCH_TOOL);
    expect(session.getActiveToolNames()).not.toContain("preview_open");
  });
});
