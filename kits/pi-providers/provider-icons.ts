import type { PreferencesStore } from "tau";
import { PI_PROVIDERS_EXTENSION_ID, type PiProviderView, type SiteIconAnswer } from "./protocol.js";

/**
 * A provider's picture, kept in the kit's values, which the host syncs to every
 * client. `none` remembers a site without an icon; `removed` is the user's
 * choice of the initial, which no automatic check overrides.
 */
export type ProviderIconChoice =
  | { kind: "site"; image: string; site: string }
  | { kind: "upload"; image: string }
  | { kind: "none"; checkedAt: number }
  | { kind: "removed" };

/** A site without an icon is asked again after a week. */
export const RECHECK_MISSING_MS = 7 * 24 * 60 * 60 * 1000;

export function providerIconKey(id: string): string {
  return `provider-icon:${id}`;
}

type Values = Pick<PreferencesStore, "value">;

function parseChoice(raw: string | undefined): ProviderIconChoice | undefined {
  if (!raw) return undefined;
  try {
    const choice = JSON.parse(raw) as ProviderIconChoice;
    if (choice?.kind === "site" || choice?.kind === "upload") return typeof choice.image === "string" && choice.image.startsWith("data:image/png;base64,") ? choice : undefined;
    return choice?.kind === "none" || choice?.kind === "removed" ? choice : undefined;
  } catch {
    return undefined;
  }
}

export function readProviderIcon(preferences: Values, id: string): ProviderIconChoice | undefined {
  return parseChoice(preferences.value(PI_PROVIDERS_EXTENSION_ID, providerIconKey(id)));
}

export function writeProviderIcon(preferences: Pick<PreferencesStore, "setValue">, id: string, choice: ProviderIconChoice): void {
  preferences.setValue(PI_PROVIDERS_EXTENSION_ID, providerIconKey(id), JSON.stringify(choice));
}

const STORED_PREFIX = `${PI_PROVIDERS_EXTENSION_ID}.${providerIconKey("")}`;

/** Every provider's picture by its id: what core's `setProviderIcons` takes. */
export function chosenProviderIcons(values: Readonly<Record<string, string>>): Record<string, string> {
  const icons: Record<string, string> = {};
  for (const [key, raw] of Object.entries(values)) {
    if (!key.startsWith(STORED_PREFIX)) continue;
    const choice = parseChoice(raw);
    if (choice?.kind === "site" || choice?.kind === "upload") icons[key.slice(STORED_PREFIX.length)] = choice.image;
  }
  return icons;
}

/** Hands core the pictures now and whenever one changes. */
export function publishProviderIcons(
  preferences: Pick<PreferencesStore, "getSnapshot" | "subscribe">,
  publish: (icons: Readonly<Record<string, string>> | undefined) => void,
): () => void {
  let values: unknown;
  let published = "";
  const update = () => {
    const next = preferences.getSnapshot().extensionValues;
    if (next === values) return;
    values = next;
    const icons = chosenProviderIcons(next);
    const signature = JSON.stringify(icons);
    if (signature === published) return;
    published = signature;
    publish(icons);
  };
  update();
  const unsubscribe = preferences.subscribe(update);
  return () => { unsubscribe(); publish(undefined); };
}

/** Whether a provider's site icon is fetched without the user asking: set up, no mark of Tau's, nothing chosen yet. */
export function wantsSiteIcon(provider: PiProviderView, choice: ProviderIconChoice | undefined, hasMark: (id: string) => boolean, now: number): boolean {
  if (!provider.site || !provider.configured || hasMark(provider.id)) return false;
  if (!choice) return true;
  return choice.kind === "none" && now - choice.checkedAt >= RECHECK_MISSING_MS;
}

export interface SiteIconSync {
  providers(): Promise<PiProviderView[]>;
  read(id: string): ProviderIconChoice | undefined;
  write(id: string, choice: ProviderIconChoice): void;
  fetch(id: string, fresh: boolean): Promise<SiteIconAnswer>;
  /** The icon drawn into a small PNG, so an SVG never reaches the page as SVG and a value stays small. */
  rasterize(image: string): Promise<string>;
  hasMark(id: string): boolean;
  now(): number;
}

/** Fetches, one after another, the site icons of the providers that want one; a failure leaves that provider for next time. */
export async function syncSiteIcons(sync: SiteIconSync): Promise<number> {
  let written = 0;
  for (const provider of await sync.providers()) {
    if (!wantsSiteIcon(provider, sync.read(provider.id), sync.hasMark, sync.now())) continue;
    try {
      written += await applySiteIcon(sync, provider.id, false) ? 1 : 0;
    } catch {
      // Offline, refused or read-only: the next catalog or start tries again.
    }
  }
  return written;
}

/** Asks the host for one provider's site icon and keeps what came, or that none did. */
export async function applySiteIcon(sync: Pick<SiteIconSync, "fetch" | "rasterize" | "write" | "now">, id: string, fresh: boolean): Promise<boolean> {
  const answer = await sync.fetch(id, fresh);
  if (!answer.image || !answer.site) {
    sync.write(id, { kind: "none", checkedAt: sync.now() });
    return false;
  }
  sync.write(id, { kind: "site", image: await sync.rasterize(answer.image), site: answer.site });
  return true;
}

/** A picked file larger than this is refused before it is read. */
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

/** A picked file as a data URL: the page's policy allows `data:` pictures, not `blob:` ones. */
function readAsDataUrl(file: Blob): Promise<string> {
  if (file.size > MAX_UPLOAD_BYTES) return Promise.reject(new Error("The picture is larger than 4 MB."));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => (typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("The picture could not be read.")));
    reader.onerror = () => reject(reader.error ?? new Error("The picture could not be read."));
    reader.readAsDataURL(file);
  });
}

/** Draws a picture (a data URL or a picked file) into a square PNG of `size` pixels. */
export async function rasterizeIcon(source: string | Blob, size = 64): Promise<string> {
  const image = new Image();
  image.src = typeof source === "string" ? source : await readAsDataUrl(source);
  await image.decode();
  if (!image.naturalWidth || !image.naturalHeight) throw new Error("The picture has no size.");
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This window cannot draw pictures.");
  const scale = Math.min(size / image.naturalWidth, size / image.naturalHeight);
  const width = image.naturalWidth * scale;
  const height = image.naturalHeight * scale;
  context.drawImage(image, (size - width) / 2, (size - height) / 2, width, height);
  return canvas.toDataURL("image/png");
}
