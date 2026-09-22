import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { WorkerHostExtension, WorkerHostExtensionContext } from "tau/host";
import { APPEARANCE_EXTENSION_ID, type SaveThemeInput, type SaveThemeResult } from "./protocol.js";
import { themeFileCss } from "./theme-css.js";
import { isThemeId, validateTokens } from "./tokens.js";

/** The desktop half's input is untrusted: only a known shape reaches the disk. */
export function readSaveThemeInput(input: unknown): SaveThemeInput {
  const value = input && typeof input === "object" ? input as Record<string, unknown> : {};
  if (!isThemeId(value.id)) throw new Error("A theme needs a name made of letters or digits.");
  const name = typeof value.name === "string" ? value.name.trim().slice(0, 64) : "";
  if (!name) throw new Error("A theme needs a name.");
  if (value.appearance !== "light" && value.appearance !== "dark") throw new Error("A theme is either light or dark.");
  const tokens = value.tokens && typeof value.tokens === "object" && !Array.isArray(value.tokens) ? value.tokens as Record<string, string> : {};
  const problems = validateTokens(tokens);
  if (problems.length > 0) throw new Error(problems[0]!.message);
  if (Object.keys(tokens).length === 0) throw new Error("A theme sets at least one colour.");
  return { id: value.id, name, appearance: value.appearance, tokens };
}

/**
 * The host half of `tau.appearance`: it writes a theme the editor made into
 * the user's themes folder, where Tau lists it like one the user put there.
 * It runs in a worker and touches nothing but that folder.
 */
export function createAppearanceHostExtension(): WorkerHostExtension & { permissions: string[] } {
  return {
    id: APPEARANCE_EXTENSION_ID,
    name: "Appearance",
    permissions: [],
    activate(context: WorkerHostExtensionContext) {
      context.registerCommand("save-theme", async (input): Promise<SaveThemeResult> => {
        let theme: SaveThemeInput;
        try {
          theme = readSaveThemeInput(input);
        } catch (error) {
          return { error: error instanceof Error ? error.message : String(error) };
        }
        const directory = context.services.themesDir;
        await mkdir(directory, { recursive: true });
        const path = join(directory, `${theme.id}.css`);
        // Written aside and moved, so the watcher never reads half a file.
        const partial = `${path}.${process.pid}.tmp`;
        await writeFile(partial, themeFileCss(theme), "utf8");
        await rename(partial, path);
        return { id: theme.id, path };
      });
    },
  };
}

export default createAppearanceHostExtension;
