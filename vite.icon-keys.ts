import type { Plugin } from "vite";

// Every lucide path carries a hash `key`, the last property of its attribute object.
const ICON_KEY = /,\s*key: "[a-z0-9]+"(?=\s*\})/gu;
const ICON_MODULE = /[\\/]lucide-react[\\/]dist[\\/]esm[\\/]icons[\\/][^\\/]+\.mjs$/u;

/**
 * Blanks the React `key` of each element in a lucide icon module's node list.
 * `Icon` renders the list as an array, so React falls back to index keys,
 * which suffice for a fixed list of SVG children. Blanking in place keeps
 * every line and column, so the module's source map stays valid.
 */
export function blankIconKeys(code: string): string {
  return code.replace(ICON_KEY, (match) => match.replace(/[^\n]/gu, " "));
}

/** Production only: without keys the development build warns about the list. */
export function stripIconKeys(): Plugin {
  let production = false;
  return {
    name: "tau-strip-icon-keys",
    apply: "build",
    configResolved(config) {
      production = config.isProduction;
    },
    transform(code, id) {
      if (!production || !ICON_MODULE.test(id)) return null;
      const result = blankIconKeys(code);
      return result === code ? null : { code: result, map: null };
    },
  };
}
