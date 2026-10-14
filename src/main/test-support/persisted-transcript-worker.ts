import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

/** Compile the real worker without requiring an Electron build before focused tests. */
export async function testPersistedTranscriptWorker(): Promise<{ url: URL; dispose(): Promise<void> }> {
  await mkdir(join(process.cwd(), ".scratch"), { recursive: true });
  const directory = await mkdtemp(join(process.cwd(), ".scratch", "transcript-worker-"));
  const outfile = join(directory, "worker.mjs");
  try {
    await build({ entryPoints: ["src/main/persisted-transcript-worker.ts"], outfile, bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "silent" });
    return { url: pathToFileURL(outfile), dispose: () => rm(directory, { recursive: true, force: true }) };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
