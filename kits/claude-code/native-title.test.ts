import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { readClaudeNativeTitle } from "./native-title.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
const SESSION = "123e4567-e89b-42d3-a456-426614174000";

it("reads the latest native metadata from the chosen Claude home, without mistaking the first prompt for a title", async () => {
  const home = await mkdtemp(join(tmpdir(), "tau-native-title-"));
  directories.push(home);
  const project = join(home, "projects", "-repo");
  await mkdir(project, { recursive: true });
  const file = join(project, `${SESSION}.jsonl`);
  const env = { CLAUDE_CONFIG_DIR: home };
  await writeFile(file, JSON.stringify({ type: "user", sessionId: SESSION, message: { content: "Screenshot.png" } }) + "\n");
  await expect(readClaudeNativeTitle(env, "/repo", SESSION)).resolves.toBeUndefined();
  await writeFile(file, [
    { type: "ai-title", sessionId: SESSION, aiTitle: "Old title" },
    { type: "ai-title", sessionId: SESSION, aiTitle: "Bildvorschau im Chat" },
    { type: "summary", summary: "The user attached Screenshot.png and asked for a fix." },
    { type: "ai-title", sessionId: "another-session", aiTitle: "Wrong title" },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  await expect(readClaudeNativeTitle(env, "/repo", SESSION)).resolves.toBe("Bildvorschau im Chat");
  await expect(readClaudeNativeTitle({ CLAUDE_CONFIG_DIR: join(home, "other-account") }, "/repo", SESSION)).resolves.toBeUndefined();
  await writeFile(file, JSON.stringify({ type: "custom-title", sessionId: SESSION, customTitle: "My title" }) + "\n" + JSON.stringify({ aiTitle: "Auto title" }) + "\n");
  await expect(readClaudeNativeTitle(env, "/repo", SESSION)).resolves.toBe("My title");
});
