import type { ManualChunkMeta, RollupLog } from "rollup";
import { readLucideExports } from "./icon-set";

const LUCIDE_ICON = /\/lucide-react\/dist\/esm\/icons\/([\w-]+)\.mjs$/u;
/**
 * Small modules lazy surfaces import, under `src/`. None imports a stylesheet
 * or another lazy chunk's module: either would change the order in which
 * dynamic imports add stylesheets, and so the cascade.
 */
export const COMMON_MODULES = [
  "shared/runtime-version.ts",
  "shared/host-updates.ts",
  "workbench/host-update-store.ts",
  "renderer/runtime-models.ts",
  "renderer/machine-updates.ts",
  "renderer/runtime-update-toasts.ts",
  "renderer/file-mention-expander.ts",
  "renderer/pairing/pairing-format.ts",
  "renderer/touch/sheet-drag.ts",
  "renderer/components/composer-fold.ts",
  "renderer/components/VirtualList.tsx",
  "renderer/components/ChangesTree.tsx",
  "renderer/components/ui/Feedback.tsx",
  "renderer/components/ui/escape-layers.ts",
  "renderer/settings/page-action.tsx",
  "renderer/settings/provider-card-state.ts",
  "renderer/settings/connections-format.ts",
];
const COMMON = new Set(COMMON_MODULES.map((path) => `/src/${path}`));

export interface EntryGraph {
  /** The modules the entry reaches through static imports, packages left out. */
  modules: Set<string>;
  /** The icon files those modules import by name, or none when one takes lucide's whole namespace. */
  icons: Set<string> | undefined;
}

const graphs = new WeakMap<ManualChunkMeta["getModuleInfo"], EntryGraph>();

/** The entry's static graph. Icons are read from the imports: lucide's barrel reaches every icon. */
export function entryGraph({ getModuleIds, getModuleInfo }: ManualChunkMeta, exports: ReadonlyMap<string, string> = readLucideExports()): EntryGraph {
  const modules = new Set<string>();
  let icons: Set<string> | undefined = new Set<string>();
  const queue = [...getModuleIds()].filter((id) => getModuleInfo(id)?.isEntry);
  while (queue.length > 0) {
    const id = queue.pop()!;
    if (modules.has(id) || id.includes("/node_modules/")) continue;
    modules.add(id);
    const info = getModuleInfo(id);
    queue.push(...(info?.importedIds ?? []));
    for (const node of info?.ast?.body ?? []) {
      if (!("source" in node) || node.source?.value !== "lucide-react") continue;
      for (const specifier of node.type === "ExportAllDeclaration" ? [undefined] : node.specifiers) {
        const name = specifier?.type === "ImportSpecifier" ? specifier.imported : specifier?.type === "ExportSpecifier" ? specifier.local : undefined;
        // Names that are no icon (`Icon`, `createLucideIcon`) are not in the map.
        const file = name && exports.get(name.type === "Identifier" ? name.name : String(name.value));
        if (!name) icons = undefined;
        else if (file) icons?.add(file);
      }
    }
  }
  return { modules, icons };
}

/** What the desktop and browser builds of the renderer share. */
export const rendererBuild = {
  output: {
    onlyExplicitManualChunks: true,
    manualChunks(id: string, meta: ManualChunkMeta) {
      // Every first highlight needs the core and a grammar. Keep their common
      // grammar code in one lazy chunk, with registration still per language.
      if (/\/node_modules\/highlight\.js\//u.test(id) || id.endsWith("/renderer/components/highlight-typescript.ts")) return "syntax-highlighting";
      // Controls and row layout already import each other. Keep the shared
      // Settings primitives together, without pulling in any Settings page.
      if (/\/renderer\/settings\/(?:controls\.tsx|settings-layout\.tsx)$/u.test(id)) return "settings-controls";
      // One lazy chunk for what several surfaces share: the dialogs, the icons only
      // lazy code draws and small helpers. One chunk each costs more than it saves.
      if (/\/renderer\/components\/ui\/(?:Dialog|ConfirmDialog)\.tsx$/u.test(id)) return "common";
      const icon = LUCIDE_ICON.exec(id)?.[1];
      const common = COMMON.has(id.slice(id.lastIndexOf("/src/")));
      if (icon || common) {
        if (!graphs.has(meta.getModuleInfo)) graphs.set(meta.getModuleInfo, entryGraph(meta));
        const entry = graphs.get(meta.getModuleInfo)!;
        // Never what the entry imports itself, which would load the chunk at start-up.
        if (icon) return entry.icons && !entry.icons.has(icon) ? "common" : undefined;
        return entry.modules.has(id) ? undefined : "common";
      }
      // These surfaces are loaded together on compact clients. One lazy chunk
      // avoids repeated imports and keeps message sheets out of the entry.
      return /\/renderer\/touch\/(?!Sheet\.tsx$).*\.tsx$/u.test(id) ? "touch-surfaces" : undefined;
    },
  },
  // A chunk cycle, such as one through the common chunk, reorders lazy stylesheets.
  onwarn(warning: RollupLog, warn: (warning: RollupLog) => void) {
    if (warning.code === "CIRCULAR_CHUNK") throw new Error(warning.message);
    warn(warning);
  },
  // The oldest engines the renderer already needs (`structuredClone`, `Array.prototype.at`).
  // Vite's default lowers every class field to a helper call, 18 KB of the initial script.
  target: ["es2022", "chrome98", "edge98", "firefox94", "safari15.4"],
  // Vite's default, which `target` would otherwise change for the stylesheet too.
  cssTarget: ["es2020", "edge88", "firefox78", "chrome87", "safari14"],
};
