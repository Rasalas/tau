import { createToolSearchExtension, type ExtensionAPI, type ExtensionFactory, type ToolDefinition, type ToolLoadout } from "@earendil-works/pi-coding-agent";

export const TOOL_SEARCH_TOOL = "tool_search";

/** One line per deferred group, with its size: the namespace, else the tool itself. */
function groupLines(loadout: ToolLoadout): string[] {
  const groups = new Map<string, { summary: string; count: number }>();
  for (const tool of loadout.registered) {
    if (loadout.getExposure(tool.name) !== "deferred") continue;
    const namespace = loadout.getNamespace(tool.name);
    const name = namespace?.name ?? tool.name;
    const group = groups.get(name) ?? { summary: (namespace?.description ?? tool.description).trim().split(/\r?\n/u)[0] ?? "", count: 0 };
    groups.set(name, { ...group, count: group.count + 1 });
  }
  return [...groups].map(([name, { summary, count }]) => `- ${name} (${count} ${count === 1 ? "tool" : "tools"}): ${summary}`);
}

/**
 * Pi's `tool_search` with the one thing the model needs to use it: a list of what
 * it can find. The list sits in the tool's own description, so it is there only
 * while the tool is active and never changes as tools load (cache-stable).
 */
function withGroupList(tool: ToolDefinition): ToolDefinition {
  return {
    ...tool,
    prepareLoadout: (loadout) => {
      const lines = groupLines(loadout);
      if (lines.length === 0) return undefined;
      const description = [
        tool.description,
        "",
        "Tools you can load (group, size: what it is for):",
        ...lines,
        "Search with a few words for what you need to do. To load a whole group, search its name with `limit` at least its size.",
      ].join("\n");
      return { descriptions: { [tool.name]: description } };
    },
  };
}

/**
 * Tools a kit registers with `exposure: "deferred"` (and a `namespace` that says
 * what the group is for) stay out of every request until the model asks for them
 * through `tool_search`. This is that search, switched on once a session has any.
 * It must be loaded before the extensions that narrow the active tools, so they
 * see it and can drop it.
 */
export function createDeferredToolsExtension(): ExtensionFactory {
  const search = createToolSearchExtension();
  return (pi: ExtensionAPI) => {
    search(new Proxy(pi, {
      get: (target, key) => {
        if (key === "registerTool") return (tool: ToolDefinition) => target.registerTool(withGroupList(tool));
        const value: unknown = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }));
    pi.on("session_start", () => {
      const active = pi.getActiveTools();
      if (active.includes(TOOL_SEARCH_TOOL) || !pi.getAllTools().some((tool) => tool.exposure === "deferred")) return;
      pi.setActiveTools([...active, TOOL_SEARCH_TOOL]);
    });
  };
}
