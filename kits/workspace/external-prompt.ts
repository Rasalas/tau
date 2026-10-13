import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function createExternalPrompt(text: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "tau-prompt-"));
  const path = join(directory, "prompt.md");
  try {
    await writeFile(path, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
    return path;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
