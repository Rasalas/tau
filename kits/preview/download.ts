import { WebContentsView, type Session, type DownloadItem, type WebContents } from "electron";
import { link, mkdtemp, realpath, rm } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";

/** An explicit download owns a separate sender, never the page the human is driving. */
export async function downloadPreviewFile(previewSession: Session, partition: string, workspace: string, url: string, destination: string): Promise<{ path: string }> {
  if (!/^https?:$/u.test(new URL(url).protocol)) throw new Error("A download needs an http(s) URL.");
  if (!workspace || !destination) throw new Error("A download needs a workspace and an explicit destination.");
  const root = await realpath(workspace);
  const asked = resolve(root, destination);
  const parent = await realpath(dirname(asked));
  if (parent !== root && !parent.startsWith(`${root}${sep}`)) throw new Error("Download destination is outside the workspace.");
  const path = join(parent, basename(asked));
  const temporary = await mkdtemp(join(parent, ".tau-download-"));
  const partial = join(temporary, "download");
  const view = new WebContentsView({ webPreferences: { partition, sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const sender = view.webContents;
  let item: DownloadItem | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let accept: (event: Electron.Event, next: DownloadItem, contents: WebContents) => void = () => undefined;
  try {
    await new Promise<void>((fulfill, reject) => {
      timer = setTimeout(() => { item?.cancel(); reject(new Error("Preview download timed out.")); }, 20_000);
      accept = (_event, next, contents) => {
        if (contents !== sender) return;
        item = next;
        next.setSavePath(partial);
        next.once("done", (_doneEvent, state) => {
          if (state === "completed") fulfill();
          else reject(new Error(`Preview download ${state}.`));
        });
      };
      previewSession.on("will-download", accept);
      sender.downloadURL(url);
    });
    // A hard link publishes atomically and fails if a human created the destination meanwhile.
    await link(partial, path);
    return { path };
  } finally {
    clearTimeout(timer);
    previewSession.off("will-download", accept);
    if (item?.getState() === "progressing") item.cancel();
    if (!sender.isDestroyed()) sender.close();
    await rm(temporary, { recursive: true, force: true });
  }
}
