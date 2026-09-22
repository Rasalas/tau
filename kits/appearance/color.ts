/** sRGB colours as the editor and the importer handle them: opaque unless said otherwise. */
export interface Rgba { r: number; g: number; b: number; a: number }

/** `#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa`, the spellings VS Code and Tau's tokens use. */
export function parseHex(value: unknown): Rgba | undefined {
  if (typeof value !== "string") return undefined;
  const hex = value.trim().replace(/^#/u, "");
  if (!/^(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/iu.test(hex)) return undefined;
  const channel = (part: string) => Number.parseInt(part.length === 1 ? part + part : part, 16);
  const parts = hex.length <= 4 ? [...hex] : hex.match(/../gu)!;
  return { r: channel(parts[0]!), g: channel(parts[1]!), b: channel(parts[2]!), a: parts[3] ? channel(parts[3]) / 255 : 1 };
}

export function toHex(color: Rgba): string {
  const channel = (value: number) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, "0");
  return `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`;
}

/** `amount` of the way from `from` to `to`. */
export function mix(from: string, to: string, amount: number): string {
  const a = parseHex(from) ?? { r: 0, g: 0, b: 0, a: 1 };
  const b = parseHex(to) ?? { r: 0, g: 0, b: 0, a: 1 };
  return toHex({ r: a.r + (b.r - a.r) * amount, g: a.g + (b.g - a.g) * amount, b: a.b + (b.b - a.b) * amount, a: 1 });
}

/** A translucent colour laid on the surface under it, since tokens are opaque. */
export function flatten(color: Rgba, over: string): string {
  if (color.a >= 1) return toHex(color);
  return mix(over, toHex(color), color.a);
}

export function luminance(value: string): number {
  const color = parseHex(value) ?? { r: 0, g: 0, b: 0, a: 1 };
  const channel = (c: number) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

export function isDark(value: string): boolean {
  return luminance(value) < 0.179;
}

/** `color` moved toward `toward` until it reads at `ratio` on `surface`, or as far as it can go. */
export function readable(color: string, surface: string, toward: string, ratio = 4.5): string {
  for (let step = 0; step <= 20; step += 1) {
    const candidate = mix(color, toward, step / 20);
    if (contrast(candidate, surface) >= ratio) return candidate;
  }
  return toward;
}
