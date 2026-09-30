import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizePath, type Plugin } from "vite";
import type { IconNode } from "lucide-react";
import { encodeIconSet, type IconAliases } from "../src/renderer/icon-set-codec";

const ICON_SET = normalizePath(fileURLToPath(new URL("../src/renderer/icon-set.ts", import.meta.url)));
const CODEC = normalizePath(fileURLToPath(new URL("../src/renderer/icon-set-codec.ts", import.meta.url)));
const EXPORT = /^export \{ default as (\w+) \} from '\.\/([\w-]+)\.mjs';$/gmu;
const NODE = /const __iconNode = (\[[\s\S]*?\]);\n/u;
const NAMES = /^export \{ ([^}]+) \} from '\.\/icons\/([\w-]+)\.mjs';$/gmu;

const esmDirectory = () => join(dirname(createRequire(import.meta.url).resolve("lucide-react")), "..", "esm");

/** Each icon of lucide's `icons` export by its file name, without the React keys. */
export function readLucideIcons(): Record<string, IconNode> {
  const directory = join(esmDirectory(), "icons");
  const icons: Record<string, IconNode> = {};
  for (const [, , file] of readFileSync(join(directory, "index.mjs"), "utf8").matchAll(EXPORT)) {
    const literal = NODE.exec(readFileSync(join(directory, `${file}.mjs`), "utf8"))?.[1];
    if (!literal) throw new Error(`lucide-react changed its icon modules (${file}); revisit vite/icon-set.ts`);
    const elements = new Function(`return ${literal}`)() as IconNode;
    icons[file!] = elements.map(([tag, { key: _key, ...attributes }]) => [tag, attributes]);
  }
  if (Object.keys(icons).length === 0) throw new Error("lucide-react changed its icon index; revisit vite/icon-set.ts");
  return icons;
}

/** Each icon file's own export name (`check` → `Check`). */
function ownNames(): Map<string, string> {
  const own = new Map<string, string>();
  for (const [, name, file] of readFileSync(join(esmDirectory(), "icons", "index.mjs"), "utf8").matchAll(EXPORT)) own.set(file!, name!);
  return own;
}

/** The icon file behind each name lucide's entry exports (`Check`, `CheckIcon`, `LucideCheck` → `check`). */
export function readLucideExports(): Map<string, string> {
  const files = new Map<string, string>();
  for (const [, list, file] of readFileSync(join(esmDirectory(), "lucide-react.mjs"), "utf8").matchAll(NAMES)) {
    for (const entry of list!.split(", ")) files.set(entry.replace(/^default as /u, ""), file!);
  }
  if (files.size === 0) throw new Error("lucide-react changed its entry; revisit vite/icon-set.ts");
  return files;
}

/**
 * The older names lucide's entry still exports for each icon file: every name
 * but the icon's own and the `…Icon` and `Lucide…` forms of each.
 */
export function readLucideAliases(icons: Record<string, IconNode> = readLucideIcons()): IconAliases {
  const own = ownNames();
  const aliases: Record<string, string[]> = {};
  for (const [, list, file] of readFileSync(join(esmDirectory(), "lucide-react.mjs"), "utf8").matchAll(NAMES)) {
    if (!(file! in icons)) continue;
    const older = list!.split(", ").map((entry) => entry.replace(/^default as /u, ""))
      .filter((name) => name !== own.get(file!) && !name.startsWith("Lucide") && !name.endsWith("Icon"));
    if (older.length > 0) aliases[file!] = older;
  }
  return aliases;
}

export function iconSetModule(icons = readLucideIcons(), aliases = readLucideAliases(icons)): string {
  return [
    'import { createLucideIcon } from "lucide-react";',
    `import { decodeIconSet } from ${JSON.stringify(CODEC)};`,
    `export const { icons, aliases } = decodeIconSet(${JSON.stringify(encodeIconSet(icons, aliases))}, createLucideIcon);`,
  ].join("\n");
}

/**
 * Production only: the icon set extensions share, as one packed string decoded
 * when its chunk loads. The chunk is 30 % smaller than with 1,790 icon modules.
 */
export function packIconSet(): Plugin {
  let production = false;
  return {
    name: "tau-pack-icon-set",
    apply: "build",
    configResolved(config) {
      production = config.isProduction;
    },
    load(id) {
      return production && id === ICON_SET ? iconSetModule() : null;
    },
  };
}
