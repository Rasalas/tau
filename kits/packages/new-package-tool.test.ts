import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostExtensionServices, HostMcpInstructionsProvider, HostMcpTool, HostMcpToolProvider, RuntimeExtensionFactory, RuntimeSessionInfo } from "tau/host-extension";
import { activateHostKit } from "../../src/main/test-support/host-kit-harness.js";
import { CUSTOMIZE_INSTRUCTIONS, CUSTOMIZE_PROJECT_INSTRUCTIONS } from "./customize-instructions.js";
import { createPackagesHostExtension } from "./host.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map((cleanup) => cleanup())); });

async function project(tau = false): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "tau-new-package-tool-"));
  cleanups.push(() => rm(path, { recursive: true, force: true }));
  await mkdir(join(path, ".git"));
  if (tau) {
    await mkdir(join(path, "kits"));
    await writeFile(join(path, "kits", "package.json"), JSON.stringify({ name: "@tau/kits" }));
  }
  return path;
}

/** A tool as the runtime calls it; the tests have no signal or context to pass. */
const run = (tool: HostMcpTool, params: unknown) => (tool.execute as unknown as (id: string, params: unknown) => Promise<{ details: Record<string, unknown> }>)("call", params);

const made = { directory: "/home/.tau/extensions/copy-branch", id: "local.copy-branch", name: "Copy Branch", apiVersion: "1.75.0", files: ["AGENTS.md"] };

async function harness(extensions = "/home/.tau/extensions") {
  const newPackage = vi.fn(async () => made);
  const runtimes = new Map<string, RuntimeExtensionFactory>();
  const providers: HostMcpToolProvider[] = [];
  const instructions: HostMcpInstructionsProvider[] = [];
  const services = {
    newPackage,
    globalExtensionsDirectory: () => extensions,
    registerRuntimeExtension: (name: string, factory: RuntimeExtensionFactory) => { runtimes.set(name, factory); return () => { runtimes.delete(name); }; },
    mcp: {
      registerTools: (provider: HostMcpToolProvider) => { providers.push(provider); return () => undefined; },
      gate: () => () => undefined,
      registerInstructions: (provider: HostMcpInstructionsProvider) => { instructions.push(provider); return () => undefined; },
      connect: async () => undefined,
    },
  } as unknown as Partial<HostExtensionServices>;
  await activateHostKit(createPackagesHostExtension(), services);
  const session = (cwd: string): RuntimeSessionInfo => ({ sessionId: "t1", cwd });
  // The packages kit also registers tau_install_package beside these; the tests look at this one's tools.
  const own = async (info: RuntimeSessionInfo) => (await Promise.all(providers.map((provider) => provider(info)))).flat().filter((tool) => tool.name !== "tau_install_package");
  return { newPackage, runtime: () => runtimes.get("tau-new-package")!, mcpTools: own, instructions, session };
}

/** The Pi side: the tools it registers and the system prompt its before_agent_start hook answers. */
function pi() {
  const tools: HostMcpTool[] = [];
  let start: ((event: { systemPrompt: string }) => unknown) | undefined;
  return {
    api: { registerTool: (tool: HostMcpTool) => tools.push(tool), on: (event: string, handler: typeof start) => { if (event === "before_agent_start") start = handler; } } as never,
    tools,
    systemPrompt: (base: string) => (start!({ systemPrompt: base }) as { systemPrompt: string } | undefined)?.systemPrompt,
  };
}

describe("tau_new_package", () => {
  it("is a tool in Pi and over MCP, and asks the host to write the package", async () => {
    const { newPackage, runtime, mcpTools, session } = await harness();
    const cwd = await project();
    const fake = pi();
    runtime()(fake.api, session(cwd));
    expect(fake.tools.map((tool) => tool.name)).toEqual(["tau_new_package", "tau_window_screenshot"]);
    const [mcpTool, shotTool] = await mcpTools(session(cwd));
    expect(mcpTool!.name).toBe("tau_new_package");
    expect(shotTool!.name).toBe("tau_window_screenshot");

    const result = await run(mcpTool!, { name: "copy-branch", displayName: "Copy branch", description: "Copies it.", host: true });
    expect(newPackage).toHaveBeenCalledWith({ slug: "copy-branch", displayName: "Copy branch", description: "Copies it.", host: true });
    expect(result.details).toMatchObject({ directory: made.directory, id: made.id, files: ["AGENTS.md"] });
    expect(String(result.details.next)).toContain("tau_install_package");
  });

  it("leaves out what was not given and defaults to the desktop half", async () => {
    const { newPackage, mcpTools, session } = await harness();
    const [tool] = await mcpTools(session("/p"));
    await run(tool!, { name: "x" });
    expect(newPackage).toHaveBeenCalledWith({ slug: "x", host: false });
  });

  it("lets the host's refusal through", async () => {
    const { newPackage, mcpTools, session } = await harness();
    newPackage.mockRejectedValueOnce(new Error("/h/.tau/extensions/x already exists"));
    const [tool] = await mcpTools(session("/p"));
    await expect(run(tool!, { name: "x" })).rejects.toThrow(/already exists/u);
  });
});

describe("the customization instructions", () => {
  it("join Pi's system prompt and MCP's instructions in a project", async () => {
    const { runtime, instructions, session } = await harness();
    const cwd = await project();
    const fake = pi();
    runtime()(fake.api, session(cwd));
    expect(fake.systemPrompt("base")).toBe(`base\n\n${CUSTOMIZE_INSTRUCTIONS}`);
    expect(instructions[0]!(session(cwd))).toBe(CUSTOMIZE_INSTRUCTIONS);
  });

  it("take the strong form in the customization project, in both", async () => {
    const folder = await project();
    const { runtime, instructions, session } = await harness(folder);
    const fake = pi();
    runtime()(fake.api, session(folder));
    expect(fake.systemPrompt("base")).toBe(`base\n\n${CUSTOMIZE_PROJECT_INSTRUCTIONS}`);
    expect(instructions[0]!(session(folder))).toBe(CUSTOMIZE_PROJECT_INSTRUCTIONS);
    expect(instructions[0]!(session(await project()))).toBe(CUSTOMIZE_INSTRUCTIONS);
  });

  it("stay out of Tau's own source checkout, in both", async () => {
    const { runtime, instructions, session } = await harness();
    const cwd = await project(true);
    const fake = pi();
    runtime()(fake.api, session(cwd));
    expect(fake.systemPrompt("base")).toBeUndefined();
    expect(instructions[0]!(session(cwd))).toBeUndefined();
  });
});
