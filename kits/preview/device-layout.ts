import type { PreviewLayoutFor, PreviewViewer } from "./protocol.js";

/** The page's layout for a device: what the view emulates. */
export interface PreviewDeviceMetrics {
  width: number;
  height: number;
  dpr: number;
  touch: boolean;
}

const SIDE = { min: 200, max: 4_000 } as const;
const DPR = { min: 1, max: 4 } as const;
const VIEWER_ID = /^[A-Za-z0-9_-]{1,64}$/u;
/** A device that asked for no frame this long has closed its view; the host window gets the page back. */
export const VIEWER_STALE_MS = 15_000;

const clamp = (value: number, range: { min: number; max: number }): number => Math.min(range.max, Math.max(range.min, value));

/** A device's description from the wire; anything malformed is no device. */
export function readPreviewViewer(value: unknown): PreviewViewer | undefined {
  const fields = value && typeof value === "object" ? value as Record<string, unknown> : undefined;
  if (!fields || typeof fields.id !== "string" || !VIEWER_ID.test(fields.id)) return undefined;
  const number = (key: string): number | undefined => {
    const field = fields[key];
    return typeof field === "number" && Number.isFinite(field) && field > 0 ? field : undefined;
  };
  const width = number("width");
  const height = number("height");
  if (width === undefined || height === undefined) return undefined;
  return {
    id: fields.id,
    width: Math.round(clamp(width, SIDE)),
    height: Math.round(clamp(height, SIDE)),
    dpr: Math.round(clamp(number("dpr") ?? 1, DPR) * 100) / 100,
    touch: fields.touch === true,
  };
}

export function deviceMetrics(viewer: PreviewViewer): PreviewDeviceMetrics {
  return { width: viewer.width, height: viewer.height, dpr: viewer.dpr, touch: viewer.touch };
}

interface Owner {
  viewer: PreviewViewer;
  name: string;
}

export interface DeviceLayoutTimers {
  set(run: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimers: DeviceLayoutTimers = {
  set: (run, ms) => {
    const handle = setTimeout(run, ms);
    (handle as { unref?: () => void }).unref?.();
    return handle;
  },
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Whose screen the page is laid out for: the host window's panel, or one
 * device. A device that watches takes it only while the host window does not
 * show the page, so the page never changes size under the user at the Mac; it
 * takes it at any time when its user asks. The host window takes it back when
 * it shows the page again, when asked, or when the device stops watching.
 */
export class DeviceLayout {
  private current: Owner | undefined;

  private timer: unknown;

  constructor(private readonly changed: () => void, private readonly timers: DeviceLayoutTimers = realTimers) {}

  owner(): PreviewLayoutFor | undefined {
    const owner = this.current;
    if (!owner) return undefined;
    const { id, width, height, touch } = owner.viewer;
    return { id, name: owner.name, width, height, touch };
  }

  metrics(): PreviewDeviceMetrics | undefined {
    return this.current ? deviceMetrics(this.current.viewer) : undefined;
  }

  /** A device asked for a frame. It keeps the page, takes a page nobody else has, or only watches. */
  watch(viewer: PreviewViewer, name: string, hostShows: boolean): void {
    if (this.current?.viewer.id === viewer.id) {
      this.take(viewer, name);
      return;
    }
    if (!hostShows && !this.current) this.take(viewer, name);
  }

  /** The device's user asked for the page at their screen's size. */
  claim(viewer: PreviewViewer, name: string): void {
    this.take(viewer, name);
  }

  /** Back to the host window; with `id`, only if that device still has the page. */
  release(id?: string): void {
    if (!this.current || (id !== undefined && this.current.viewer.id !== id)) return;
    this.current = undefined;
    this.stopTimer();
    this.changed();
  }

  dispose(): void {
    this.current = undefined;
    this.stopTimer();
  }

  private take(viewer: PreviewViewer, name: string): void {
    const before = this.current;
    this.current = { viewer, name };
    this.stopTimer();
    this.timer = this.timers.set(() => this.release(viewer.id), VIEWER_STALE_MS);
    const same = before && before.name === name && JSON.stringify(before.viewer) === JSON.stringify(viewer);
    if (!same) this.changed();
  }

  private stopTimer(): void {
    if (this.timer !== undefined) this.timers.clear(this.timer);
    this.timer = undefined;
  }
}
