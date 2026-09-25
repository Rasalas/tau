// A Pi agent directory of an instance's or test host's own, beside the user's real ~/.pi/agent.
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * A Pi agent directory of the instance's own. Pi writes into its agent dir on
 * its own (`lastChangelogVersion`, the default model when one is picked), and
 * Settings → Keybindings writes keybindings.json, so an instance must not run
 * on the user's. The login, model list, packages and extensions are linked;
 * settings, the model store, trust and keybindings are copied once and then
 * belong to the instance.
 */
export function preparePiAgentDir(agentDir, realDir = join(homedir(), ".pi", "agent")) {
  mkdirSync(agentDir, { recursive: true });
  for (const name of ["auth.json", "models.json", "npm", "extensions"]) {
    const link = join(agentDir, name);
    let present = false;
    try { present = lstatSync(link) !== undefined; } catch { /* not there yet */ }
    if (!present && existsSync(join(realDir, name))) symlinkSync(join(realDir, name), link);
  }
  // Older instances linked keybindings.json; a save would reach the real file through the link.
  const keys = join(agentDir, "keybindings.json");
  let linkedKeys = false;
  try { linkedKeys = lstatSync(keys).isSymbolicLink(); } catch { /* not there */ }
  if (linkedKeys) {
    const content = existsSync(keys) ? readFileSync(keys) : undefined;
    rmSync(keys);
    if (content) writeFileSync(keys, content);
  }
  for (const name of ["settings.json", "models-store.json", "trust.json", "keybindings.json"]) {
    const copy = join(agentDir, name);
    if (!existsSync(copy) && existsSync(join(realDir, name))) {
      const content = readFileSync(join(realDir, name));
      writeFileSync(copy, name === "settings.json" ? withTestDefaultModel(content) : content);
    }
  }
}

/** Test prompts, and the automatic ones a new draft sends (titles, commit messages), run on the cheapest model. */
export function withTestDefaultModel(content) {
  let settings;
  try { settings = JSON.parse(String(content)); } catch { return content; }
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return content;
  return `${JSON.stringify({ ...settings, defaultProvider: "openai-codex", defaultModel: "gpt-5.6-luna" }, null, 2)}\n`;
}
