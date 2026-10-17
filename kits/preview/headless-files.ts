import { link, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const inside = (root: string, path: string): boolean => {
  const child = relative(root, path);
  return !isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`);
};

/** Resolve symlinks as well as URL escapes before granting a local request. */
export async function previewFileAllowed(url: string, workspace: string): Promise<boolean> {
  if (!url.startsWith("file:")) return true;
  if (!workspace) return false;
  try { return inside(await realpath(workspace), await realpath(fileURLToPath(url))); }
  catch { return false; }
}

/** Publish without overwrite, including when the destination's parent is a symlink. */
export async function savePreviewDownload(workspace: string, destination: string, bytes: Uint8Array): Promise<{ path: string }> {
  if (!workspace || !destination) throw new Error("A download needs a workspace and an explicit destination.");
  const root = await realpath(workspace);
  const asked = resolve(root, destination);
  const parent = await realpath(dirname(asked));
  if (!inside(root, parent)) throw new Error("Download destination is outside the workspace.");
  const path = join(parent, basename(asked));
  const temporary = await mkdtemp(join(parent, ".tau-download-"));
  try {
    const partial = join(temporary, "download");
    await writeFile(partial, bytes);
    await link(partial, path);
    return { path };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
