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
    // Use the production worker options, including its SDK dependency isolation.
    const { persistedTranscriptWorkerBuildOptions } = await import(new URL("../../../scripts/persisted-transcript-worker-build.mjs", import.meta.url).href);
    await build(persistedTranscriptWorkerBuildOptions(process.cwd(), outfile));
    return { url: pathToFileURL(outfile), dispose: () => rm(directory, { recursive: true, force: true }) };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
