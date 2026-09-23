/** How long each picture stays on screen in an exported video. */
export const VIDEO_FRAME_MS = 900;
const CAPTION_BAND = 34;

export interface VideoFrame {
  /** A data URL. */
  url: string;
  caption: string;
  at: number;
}

const loadImage = (url: string): Promise<HTMLImageElement> => new Promise((resolve, reject) => {
  const image = new Image();
  image.onload = () => resolve(image);
  image.onerror = () => reject(new Error("A picture could not be read."));
  image.src = url;
});

const wait = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

/** The first webm type this renderer's recorder takes. */
export function videoType(supported: (type: string) => boolean = (type) => MediaRecorder.isTypeSupported(type)): string {
  return ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find(supported) ?? "video/webm";
}

/** "Clicked “Save” · 14:02:11", the line under each picture. */
export function captionLine(frame: Pick<VideoFrame, "caption" | "at">): string {
  const time = new Date(frame.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return `${frame.caption} · ${time}`;
}

/**
 * The pictures as a short webm, each for `VIDEO_FRAME_MS` with its caption
 * under it: drawn on a canvas and recorded as it plays, so the export takes
 * as long as the video lasts. `progress` hears each picture as it is drawn.
 */
export async function exportVideo(frames: readonly VideoFrame[], progress?: (done: number, total: number) => void): Promise<Blob> {
  if (frames.length === 0) throw new Error("There are no pictures to export.");
  const images = await Promise.all(frames.map((frame) => loadImage(frame.url)));
  const width = Math.max(...images.map((image) => image.naturalWidth)) & ~1;
  const height = (Math.max(...images.map((image) => image.naturalHeight)) + CAPTION_BAND) & ~1;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This window cannot draw a video.");
  const draw = (index: number) => {
    const image = images[index]!;
    context.fillStyle = "#111";
    context.fillRect(0, 0, width, height);
    context.drawImage(image, Math.round((width - image.naturalWidth) / 2), 0);
    context.fillStyle = "#eee";
    context.font = "14px system-ui, sans-serif";
    context.textBaseline = "middle";
    context.fillText(`${String(index + 1)}/${String(frames.length)}  ${captionLine(frames[index]!)}`, 12, height - CAPTION_BAND / 2, width - 24);
  };
  draw(0);
  const stream = canvas.captureStream(10);
  const type = videoType();
  const recorder = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 1_500_000 });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) => { if (event.data.size > 0) chunks.push(event.data); };
  const stopped = new Promise<void>((resolve) => { recorder.onstop = () => resolve(); });
  recorder.start(500);
  for (let index = 0; index < frames.length; index += 1) {
    draw(index);
    progress?.(index + 1, frames.length);
    await wait(VIDEO_FRAME_MS);
  }
  recorder.stop();
  await stopped;
  for (const track of stream.getTracks()) track.stop();
  return new Blob(chunks, { type: type.split(";")[0] });
}

/** Hands a file to whatever this client does with a download: a save sheet in the window, the browser's list on the web. */
export function saveFile(blob: Blob | string, name: string): void {
  const url = typeof blob === "string" ? blob : URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
  if (typeof blob !== "string") setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** `evidence-2026-09-23-1402`, a name that sorts by when the turn started. */
export function exportName(at: number, extension: string): string {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `evidence-${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}.${extension}`;
}
