import { HostCommandError } from "tau/host-extension";

/** The largest file Tau reads to expand a diff; a bigger one is left to the website. */
export const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** Refuses a file too large or binary to show as lines; the text itself otherwise. */
export function checkFileText(path: string, text: string): string {
  if (Buffer.byteLength(text) > MAX_FILE_BYTES) throw new HostCommandError(`${path} is larger than 2 MB; Tau does not expand it.`);
  if (text.includes("\0")) throw new HostCommandError(`${path} is a binary file.`);
  return text;
}

/** Runs one host read of `path` and checks the answer; a missing file and an oversized answer become sentences naming it. */
export async function readFileText(path: string, read: () => Promise<string>): Promise<string> {
  let text: string;
  try {
    text = await read();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/maxBuffer/iu.test(message)) throw new HostCommandError(`${path} is larger than 2 MB; Tau does not expand it.`);
    if (/HTTP 404|not found|could not be found|does not exist/iu.test(message)) throw new HostCommandError(`${path} is not in the request's head commit.`);
    throw error;
  }
  return checkFileText(path, text);
}
