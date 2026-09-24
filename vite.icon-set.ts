import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizePath, type Plugin } from "vite";
import type { IconNode } from "lucide-react";
import { encodeIconSet } from "./src/renderer/icon-set-codec";

const ICON_SET = normalizePath(fileURLToPath(new URL("src/renderer/icon-set.ts", import.meta.url)));
const CODEC = normalizePath(fileURLToPath(new URL("src/renderer/icon-set-codec.ts", import.meta.url)));
const EXPORT = /^export \{ default as (\w+) \} from '\.\/([\w-]+)\.mjs';$/gmu;
const NODE = /const __iconNode = (\[[\s\S]*?\]);\n/u;

/** Each icon of lucide's `icons` export by its file name, without the React keys. */
export function readLucideIcons(): Record<string, IconNode> {
  const directory = join(dirname(createRequire(import.meta.url).resolve("lucide-react")), "..", "esm", "icons");
  const icons: Record<string, IconNode> = {};
  for (const [, , file] of readFileSync(join(directory, "index.mjs"), "utf8").matchAll(EXPORT)) {
    const literal = NODE.exec(readFileSync(join(directory, `${file}.mjs`), "utf8"))?.[1];
    if (!literal) throw new Error(`lucide-react changed its icon modules (${file}); revisit vite.icon-set.ts`);
    const elements = new Function(`return ${literal}`)() as IconNode;
    icons[file!] = elements.map(([tag, { key: _key, ...attributes }]) => [tag, attributes]);
  }
  if (Object.keys(icons).length === 0) throw new Error("lucide-react changed its icon index; revisit vite.icon-set.ts");
  return icons;
}

export function iconSetModule(icons = readLucideIcons()): string {
  return [
    'import { createLucideIcon } from "lucide-react";',
    `import { decodeIconSet } from ${JSON.stringify(CODEC)};`,
    `export const icons = decodeIconSet(${JSON.stringify(encodeIconSet(icons))}, createLucideIcon);`,
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
