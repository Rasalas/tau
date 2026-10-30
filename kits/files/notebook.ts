/** Saved notebook reads have a separate 10 MiB budget. Never parse a cut JSON prefix. */
export const NOTEBOOK_MAX_BYTES = 10 * 1024 * 1024;
export const NOTEBOOK_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const NOTEBOOK_MAX_IMAGES = 30;
export const NOTEBOOK_MAX_CELLS = 500;
export const NOTEBOOK_MAX_OUTPUTS_PER_CELL = 100;
export const NOTEBOOK_MAX_OUTPUTS = 1000;
export const NOTEBOOK_MAX_TEXT_CHARS = 32 * 1024;
export const NOTEBOOK_MAX_TOTAL_CHARS = 256 * 1024;

export interface NotebookOutput {
  kind: "text" | "error" | "notice" | "image";
  mime?: string;
  label: string;
  text: string;
}

export interface NotebookCell {
  kind: "markdown" | "code" | "raw" | "unknown";
  source: string;
  executionCount: number | null;
  outputs: NotebookOutput[];
  notices: string[];
}

export type NotebookPreview =
  | { ok: false; error: string }
  | { ok: true; language: string; cellCount: number; cells: NotebookCell[]; notices: string[] };

/** Saved nbformat 4 data only. Only bounded saved text and passive image data leave this parser. */
export function parseNotebook(text: string, { truncated = false }: { truncated?: boolean } = {}): NotebookPreview {
  // Kept self-contained for the disposable host worker, including in host.cjs.
  const LOCAL_NOTEBOOK_MAX_BYTES = 10 * 1024 * 1024;
  const LOCAL_NOTEBOOK_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
  const LOCAL_NOTEBOOK_MAX_IMAGES = 30;
  const LOCAL_NOTEBOOK_MAX_CELLS = 500;
  const LOCAL_NOTEBOOK_MAX_OUTPUTS_PER_CELL = 100;
  const LOCAL_NOTEBOOK_MAX_OUTPUTS = 1000;
  const LOCAL_NOTEBOOK_MAX_TEXT_CHARS = 32 * 1024;
  const LOCAL_NOTEBOOK_MAX_TOTAL_CHARS = 256 * 1024;
  function record(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  }

  /** Remove terminal escapes, including OSC links, from saved text, never interpret them. */
  function plainOutput(value: string): string {
    // oxlint-disable-next-line eslint/no-control-regex -- Remove saved ANSI sequences and nonprinting controls, retaining tabs and newlines.
    return value.replace(/(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, "");
  }

  if (truncated) return { ok: false, error: "This notebook was only partly loaded. Switch to source to read the loaded text, or open it in an editor for the full file." };
  if (text.length > LOCAL_NOTEBOOK_MAX_BYTES || new TextEncoder().encode(text).byteLength > LOCAL_NOTEBOOK_MAX_BYTES) {
    return { ok: false, error: "Notebook preview is limited to 10 MB. Switch to source or open it in an editor." };
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text.replace(/^\uFEFF/u, "")); }
  catch { return { ok: false, error: "This notebook is not valid JSON. Switch to source to inspect or repair it." }; }
  const notebook = record(parsed);
  if (notebook.nbformat !== 4 || !Array.isArray(notebook.cells)) {
    return { ok: false, error: "Preview supports Jupyter notebooks in nbformat 4 with a cells array. Switch to source to inspect this file." };
  }
  const metadata = record(notebook.metadata);
  const name = record(metadata.language_info).name ?? record(metadata.kernelspec).language;
  const language = typeof name === "string" && /^[a-z][a-z\d+#-]{0,39}$/iu.test(name) ? name.toLowerCase() : "text";
  const notices: string[] = [];
  if (notebook.cells.length > LOCAL_NOTEBOOK_MAX_CELLS) notices.push(`Preview limited to the first ${LOCAL_NOTEBOOK_MAX_CELLS} of ${notebook.cells.length} cells. Switch to source for the rest.`);
  let remaining = LOCAL_NOTEBOOK_MAX_TOTAL_CHARS;
  let outputCount = 0;
  let imageCount = 0;
  const started = Date.now();
  function imageOutput(data: Record<string, unknown>, notes: string[]): NotebookOutput | undefined {
    const mime = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml"].find((type) => data[type] !== undefined);
    if (!mime) return undefined;
    if (imageCount >= LOCAL_NOTEBOOK_MAX_IMAGES) { notes.push("Image output omitted: notebook limit of 30 images reached."); return undefined; }
    const value = data[mime];
    const parts = typeof value === "string" ? [value] : Array.isArray(value) && value.every((part) => typeof part === "string") ? value as string[] : [];
    const length = parts.reduce((sum, part) => sum + part.length, 0);
    if (length > Math.ceil(LOCAL_NOTEBOOK_MAX_IMAGE_BYTES / 3) * 4 + 1024) { notes.push("Image output omitted: larger than 5 MB."); return undefined; }
    let body = parts.join("");
    if (mime === "image/svg+xml") {
      if (new TextEncoder().encode(body).byteLength > LOCAL_NOTEBOOK_MAX_IMAGE_BYTES) { notes.push("Image output omitted: larger than 5 MB."); return undefined; }
      // An img is already inert. Reject resource-bearing SVG too, so the saved
      // bytes cannot initiate a request in any image renderer or lightbox.
      body = body.replace(/^\s*<\?xml\s[^?]*\?>/u, "").replace(/<!DOCTYPE\s+svg(?:\s+(?:PUBLIC\s+"[^"<>[\]]*"\s+"[^"<>[\]]*"|SYSTEM\s+"[^"<>[\]]*"))?\s*>/iu, "").replace(/<!--[^]*?-->/gu, "").replace(/<metadata\b[^>]*>[^]*?<\/metadata\s*>/giu, "").trim();
      const allowedTags = new Set(["svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "text", "tspan", "defs", "clipPath", "mask", "linearGradient", "radialGradient", "stop", "title", "desc", "style", "use"]);
      const badReferences = [...body.matchAll(/\b(?:[\w.-]+:)?(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)')/giu)].some((match) => !/^#[\w:.-]+$/u.test(match[1] ?? match[2] ?? ""));
      const badUrls = [...body.matchAll(/url\s*\(([^)]*)\)/giu)].some((match) => !/^\s*['"]?#[\w:.-]+['"]?\s*$/u.test(match[1]!));
      if ([...body.matchAll(/<\/?([\w:.-]+)/gu)].some((match) => !allowedTags.has(match[1]!)) || !/^<svg[\s>]/u.test(body) || badReferences || badUrls || /\\|@import|<\s*(?:script|foreignObject|image|animate|set)\b|\bon[a-z]+\s*=|<!|<\?/iu.test(body)) { notes.push("Rich output omitted. SVG contains unsupported active or external content."); return undefined; }
    } else {
      body = body.replace(/\s/gu, "");
      if (!body || body.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(body)) { notes.push("Rich output omitted. Image data is not valid base64."); return undefined; }
      const size = body.length / 4 * 3 - (body.endsWith("==") ? 2 : body.endsWith("=") ? 1 : 0);
      if (size > LOCAL_NOTEBOOK_MAX_IMAGE_BYTES) { notes.push("Image output omitted: larger than 5 MB."); return undefined; }
      // Check signatures before the browser decoder sees saved bytes.
      const prefix = atob(body.slice(0, 32));
      const valid = mime === "image/png" ? prefix.startsWith("\x89PNG\r\n\x1a\n") : mime === "image/jpeg" ? prefix.startsWith("\xff\xd8\xff") : mime === "image/gif" ? /^GIF8[79]a/u.test(prefix) : prefix.startsWith("RIFF") && prefix.slice(8, 12) === "WEBP";
      if (!valid) { notes.push("Rich output omitted. Image data does not match its saved type."); return undefined; }
    }
    imageCount++;
    return { kind: "image", mime, label: "Output image", text: body };
  }

  // Bound each field while joining it, and the total text passed to React/Markdown.
  const readText = (value: unknown, notes: string[], label: string, separator = ""): string => {
    const parts = typeof value === "string" ? [value] : Array.isArray(value) ? value : undefined;
    if (!parts || parts.some((part) => typeof part !== "string")) {
      notes.push(`${label} is not a string or an array of strings. Switch to source to inspect it.`);
      return "";
    }
    const limit = Math.min(LOCAL_NOTEBOOK_MAX_TEXT_CHARS, remaining);
    let result = "";
    let cut = false;
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index] as string;
      const prefix = index > 0 ? separator : "";
      const room = limit - result.length;
      if (prefix.length + part.length > room) {
        result += (prefix + part).slice(0, room);
        cut = true;
        break;
      }
      result += prefix + part;
    }
    remaining -= result.length;
    if (cut) notes.push(`${label} was shortened for preview. Switch to source for the rest.`);
    return result;
  };
  const cells: NotebookCell[] = [];
  for (const value of notebook.cells.slice(0, LOCAL_NOTEBOOK_MAX_CELLS)) {
    if (Date.now() - started > 2500) { notices.push("Notebook parsing time limit reached. Switch to source for the rest."); break; }
    if (remaining === 0) {
      notices.push("Notebook text limit reached. Switch to source for the remaining cells and outputs.");
      break;
    }
    const cell = record(value);
    const notes: string[] = [];
    const kind = cell.cell_type === "markdown" || cell.cell_type === "code" || cell.cell_type === "raw" ? cell.cell_type : "unknown";
    if (kind === "unknown") notes.push("Unknown cell type. Its source is shown as plain text.");
    const source = readText(cell.source, notes, "Cell source");
    const outputs: NotebookOutput[] = [];
    if (kind === "code" && cell.outputs !== undefined && !Array.isArray(cell.outputs)) notes.push("Cell outputs are malformed. Switch to source to inspect them.");
    const savedOutputs = kind === "code" && Array.isArray(cell.outputs) ? cell.outputs : [];
    for (const entry of savedOutputs.slice(0, LOCAL_NOTEBOOK_MAX_OUTPUTS_PER_CELL)) {
      if (outputCount >= LOCAL_NOTEBOOK_MAX_OUTPUTS || remaining === 0) {
        notes.push("Notebook output or text limit reached. Switch to source for the remaining outputs.");
        break;
      }
      outputCount += 1;
      const output = record(entry);
      const data = record(output.data);
      const outputNotes: string[] = [];
      let body: string;
      let label = "Output";
      let outputKind: NotebookOutput["kind"] = "text";
      if (output.output_type === "stream") {
        label = output.name === "stderr" ? "stderr" : "stdout";
        body = readText(output.text, outputNotes, "Stream output");
      } else if (output.output_type === "error") {
        outputKind = "error";
        label = "Error";
        // Traceback entries are lines, unlike source/stream string fragments.
        if (Array.isArray(output.traceback) && output.traceback.length > 0) {
          body = readText(output.traceback, outputNotes, "Error traceback", "\n");
        } else {
          const errorName = typeof output.ename === "string" ? output.ename : "Error";
          const errorValue = typeof output.evalue === "string" ? output.evalue : "";
          if ((output.ename !== undefined && typeof output.ename !== "string") || (output.evalue !== undefined && typeof output.evalue !== "string") || (output.traceback !== undefined && !Array.isArray(output.traceback))) {
            outputNotes.push("Error details are malformed. Switch to source to inspect them.");
          }
          body = readText(errorValue ? [errorName, ": ", errorValue] : errorName, outputNotes, "Error message");
        }
      } else if (output.output_type === "display_data" || output.output_type === "execute_result") {
        body = data["text/plain"] === undefined ? "" : readText(data["text/plain"], outputNotes, "Text output");
        const image = imageOutput(data, outputNotes);
        if (image) outputs.push(image);
        if (Object.keys(data).some((mime) => mime !== "text/plain" && mime !== image?.mime) && outputNotes.length === 0) outputNotes.push("Rich output omitted. Only saved text/plain output is shown.");
        else if (!image && outputNotes.length === 0 && data["text/plain"] === undefined) outputNotes.push("No saved text/plain output. Switch to source to inspect this output.");
      } else {
        body = "";
        outputNotes.push("Unsupported output type. Switch to source to inspect this output.");
      }
      if (body) outputs.push({ kind: outputKind, label, text: plainOutput(body) });
      for (const note of outputNotes) outputs.push({ kind: "notice", label: "Output notice", text: note });
    }
    if (savedOutputs.length > LOCAL_NOTEBOOK_MAX_OUTPUTS_PER_CELL) notes.push(`Preview limited to the first ${LOCAL_NOTEBOOK_MAX_OUTPUTS_PER_CELL} outputs in this cell. Switch to source for the rest.`);
    const count = cell.execution_count;
    cells.push({ kind, source, outputs, notices: notes, executionCount: typeof count === "number" && Number.isSafeInteger(count) && count >= 0 ? count : null });
  }
  return { ok: true, language, cellCount: notebook.cells.length, cells, notices };
}
