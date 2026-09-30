import type { ManualChunkMeta } from "rollup";
import { readLucideExports } from "./icon-set";

const LUCIDE_ICON = /\/lucide-react\/dist\/esm\/icons\/([\w-]+)\.mjs$/u;
const entryIconsByBuild = new WeakMap<ManualChunkMeta["getModuleInfo"], Set<string> | undefined>();

/**
 * The icon files the entry's own modules import from `lucide-react`, or none
 * when one of them takes the whole namespace. The module graph cannot tell:
 * lucide's barrel imports every icon.
 */
export function entryIconFiles({ getModuleIds, getModuleInfo }: ManualChunkMeta, exports: ReadonlyMap<string, string> = readLucideExports()): Set<string> | undefined {
  const files = new Set<string>();
  const seen = new Set<string>();
  const queue = [...getModuleIds()].filter((id) => getModuleInfo(id)?.isEntry);
  while (queue.length > 0) {
    const id = queue.pop()!;
    if (seen.has(id) || id.includes("/node_modules/")) continue;
    seen.add(id);
    const info = getModuleInfo(id);
    queue.push(...(info?.importedIds ?? []));
    for (const node of info?.ast?.body ?? []) {
      if (!("source" in node) || node.source?.value !== "lucide-react") continue;
      if (node.type === "ExportAllDeclaration") return undefined;
      for (const specifier of node.specifiers) {
        const name = specifier.type === "ImportSpecifier" ? specifier.imported : specifier.type === "ExportSpecifier" ? specifier.local : undefined;
        if (!name) return undefined;
        // Names that are no icon (`Icon`, `createLucideIcon`) are not in the map.
        const file = exports.get(name.type === "Identifier" ? name.name : String(name.value));
        if (file) files.add(file);
      }
    }
  }
  return files;
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
      // These dialogs share their focus and closing behavior.
      if (/\/renderer\/components\/ui\/(?:Dialog|ConfirmDialog)\.tsx$/u.test(id)) return "dialogs";
      // Icons only lazy surfaces draw go with the dialogs, which most of those surfaces open,
      // instead of one chunk per icon that two surfaces share.
      const icon = LUCIDE_ICON.exec(id)?.[1];
      if (icon) {
        if (!entryIconsByBuild.has(meta.getModuleInfo)) entryIconsByBuild.set(meta.getModuleInfo, entryIconFiles(meta));
        const entryIcons = entryIconsByBuild.get(meta.getModuleInfo);
        return entryIcons && !entryIcons.has(icon) ? "dialogs" : undefined;
      }
      // These surfaces are loaded together on compact clients. One lazy chunk
      // avoids repeated imports and keeps message sheets out of the entry.
      return /\/renderer\/touch\/(?!Sheet\.tsx$).*\.tsx$/u.test(id) ? "touch-surfaces" : undefined;
    },
  },
  // The oldest engines the renderer already needs (`structuredClone`, `Array.prototype.at`).
  // Vite's default lowers every class field to a helper call, 18 KB of the initial script.
  target: ["es2022", "chrome98", "edge98", "firefox94", "safari15.4"],
  // Vite's default, which `target` would otherwise change for the stylesheet too.
  cssTarget: ["es2020", "edge88", "firefox78", "chrome87", "safari14"],
};
