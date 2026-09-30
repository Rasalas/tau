import type { NativeImage, nativeImage as NativeImageModule } from "electron";
import { MENU_ICONS, type MenuIconNode } from "./menu-icon-set.js";

type Point = readonly [number, number];

const NUMBER = /[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/iy;
const CURVE_STEPS = 12;

function cubic(line: Point[], from: Point, c1: Point, c2: Point, to: Point): void {
  for (let step = 1; step <= CURVE_STEPS; step += 1) {
    const t = step / CURVE_STEPS;
    const u = 1 - t;
    const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
    line.push([a * from[0] + b * c1[0] + c * c2[0] + d * to[0], a * from[1] + b * c1[1] + c * c2[1] + d * to[1]]);
  }
}

/** SVG's endpoint arc as points, through its centre form (SVG 1.1, F.6.5). */
function arc(line: Point[], from: Point, radiusX: number, radiusY: number, rotation: number, large: boolean, sweep: boolean, to: Point): void {
  let rx = Math.abs(radiusX), ry = Math.abs(radiusY);
  if (rx === 0 || ry === 0) { line.push(to); return; }
  const phi = rotation * Math.PI / 180;
  const cos = Math.cos(phi), sin = Math.sin(phi);
  const dx = (from[0] - to[0]) / 2, dy = (from[1] - to[1]) / 2;
  const x1 = cos * dx + sin * dy, y1 = -sin * dx + cos * dy;
  const scale = x1 * x1 / (rx * rx) + y1 * y1 / (ry * ry);
  if (scale > 1) { rx *= Math.sqrt(scale); ry *= Math.sqrt(scale); }
  const sign = large === sweep ? -1 : 1;
  const root = Math.sqrt(Math.max(0, (rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1) / (rx * rx * y1 * y1 + ry * ry * x1 * x1)));
  const cx1 = sign * root * rx * y1 / ry, cy1 = -sign * root * ry * x1 / rx;
  const cx = cos * cx1 - sin * cy1 + (from[0] + to[0]) / 2, cy = sin * cx1 + cos * cy1 + (from[1] + to[1]) / 2;
  const angle = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const start = angle(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
  let delta = angle((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
  if (!sweep && delta > 0) delta -= 2 * Math.PI;
  if (sweep && delta < 0) delta += 2 * Math.PI;
  const steps = Math.max(2, Math.ceil(Math.abs(delta) / (Math.PI / 16)));
  for (let step = 1; step <= steps; step += 1) {
    const theta = start + delta * step / steps;
    const ex = rx * Math.cos(theta), ey = ry * Math.sin(theta);
    line.push([cos * ex - sin * ey + cx, sin * ex + cos * ey + cy]);
  }
}

/** A path's `d` as polylines; M, L, H, V, C, S, Q, A and Z, absolute or relative. */
function pathLines(d: string): Point[][] {
  const lines: Point[][] = [];
  let line: Point[] = [];
  let at = 0;
  let command = "";
  let x = 0, y = 0, startX = 0, startY = 0;
  let control: Point | undefined;
  const skip = () => { while (at < d.length && /[\s,]/u.test(d[at]!)) at += 1; };
  const number = () => {
    skip();
    NUMBER.lastIndex = at;
    const match = NUMBER.exec(d);
    if (!match) throw new Error(`menu icon: bad number in path at ${at}`);
    at = NUMBER.lastIndex;
    return Number(match[0]);
  };
  const flag = () => { skip(); return d[at++] === "1"; };
  const flush = () => { if (line.length > 0) lines.push(line); line = []; };
  for (skip(); at < d.length; skip()) {
    if (/[a-z]/iu.test(d[at]!)) command = d[at++]!;
    else if (!command || command === "Z" || command === "z") throw new Error(`menu icon: bad path at ${at}`);
    const relative = command === command.toLowerCase();
    const ox = relative ? x : 0, oy = relative ? y : 0;
    const from: Point = [x, y];
    const upper = command.toUpperCase();
    if (upper === "M") {
      flush();
      x = ox + number(); y = oy + number();
      startX = x; startY = y;
      line.push([x, y]);
      command = relative ? "l" : "L";
    } else if (upper === "L") {
      x = ox + number(); y = oy + number();
      line.push([x, y]);
    } else if (upper === "H") {
      x = ox + number();
      line.push([x, y]);
    } else if (upper === "V") {
      y = oy + number();
      line.push([x, y]);
    } else if (upper === "C" || upper === "S") {
      const c1: Point = upper === "C" ? [ox + number(), oy + number()] : control ? [2 * x - control[0], 2 * y - control[1]] : from;
      const c2: Point = [ox + number(), oy + number()];
      x = ox + number(); y = oy + number();
      cubic(line, from, c1, c2, [x, y]);
      control = c2;
      continue;
    } else if (upper === "Q") {
      const q: Point = [ox + number(), oy + number()];
      x = ox + number(); y = oy + number();
      cubic(line, from, [from[0] + 2 / 3 * (q[0] - from[0]), from[1] + 2 / 3 * (q[1] - from[1])], [x + 2 / 3 * (q[0] - x), y + 2 / 3 * (q[1] - y)], [x, y]);
    } else if (upper === "A") {
      const rx = number(), ry = number(), rotation = number(), large = flag(), sweep = flag();
      x = ox + number(); y = oy + number();
      arc(line, from, rx, ry, rotation, large, sweep, [x, y]);
    } else if (upper === "Z") {
      line.push([startX, startY]);
      x = startX; y = startY;
      flush();
      line.push([x, y]);
    } else {
      throw new Error(`menu icon: path command ${command} is not supported`);
    }
    control = undefined;
  }
  flush();
  return lines.filter((points) => points.length > 1 || lines.length === 1);
}

function ellipse(cx: number, cy: number, rx: number, ry: number): Point[] {
  const points: Point[] = [];
  for (let step = 0; step <= 48; step += 1) {
    const theta = step / 48 * 2 * Math.PI;
    points.push([cx + rx * Math.cos(theta), cy + ry * Math.sin(theta)]);
  }
  return points;
}

function rect(x: number, y: number, width: number, height: number, rx: number, ry: number): Point[] {
  if (rx <= 0 && ry <= 0) return [[x, y], [x + width, y], [x + width, y + height], [x, y + height], [x, y]];
  const d = `M${x + rx} ${y}H${x + width - rx}A${rx} ${ry} 0 0 1 ${x + width} ${y + ry}V${y + height - ry}A${rx} ${ry} 0 0 1 ${x + width - rx} ${y + height}`
    + `H${x + rx}A${rx} ${ry} 0 0 1 ${x} ${y + height - ry}V${y + ry}A${rx} ${ry} 0 0 1 ${x + rx} ${y}Z`;
  return pathLines(d)[0]!;
}

/** An icon's strokes as polylines on its 24-unit grid. */
export function iconLines(node: MenuIconNode): Point[][] {
  return node.flatMap(([tag, attributes]): Point[][] => {
    const value = (name: string) => Number(attributes[name] ?? 0);
    if (tag === "path") return pathLines(attributes.d ?? "");
    if (tag === "line") return [[[value("x1"), value("y1")], [value("x2"), value("y2")]]];
    if (tag === "circle") return [ellipse(value("cx"), value("cy"), value("r"), value("r"))];
    if (tag === "ellipse") return [ellipse(value("cx"), value("cy"), value("rx"), value("ry"))];
    if (tag === "rect") {
      const rx = attributes.rx ?? attributes.ry, ry = attributes.ry ?? attributes.rx;
      return [rect(value("x"), value("y"), value("width"), value("height"), Number(rx ?? 0), Number(ry ?? 0))];
    }
    if (tag === "polyline" || tag === "polygon") {
      const numbers = (attributes.points ?? "").trim().split(/[\s,]+/u).map(Number);
      const points: Point[] = [];
      for (let index = 0; index + 1 < numbers.length; index += 2) points.push([numbers[index]!, numbers[index + 1]!]);
      if (tag === "polygon" && points.length > 0) points.push(points[0]!);
      return [points];
    }
    throw new Error(`menu icon: <${tag}> is not supported`);
  });
}

const SAMPLES = 4;
/** Lucide's stroke-width 2, halved, in grid units. */
const HALF_STROKE = 1;

/**
 * The icon as a `size` × `size` BGRA bitmap, premultiplied, in `rgb`: lucide's
 * round-capped, round-joined 2-unit stroke is every point within 1 of a line.
 */
export function menuIconBitmap(name: string, size: number, rgb: readonly [number, number, number] = [0, 0, 0]): Buffer | undefined {
  const node = Object.hasOwn(MENU_ICONS, name) ? MENU_ICONS[name] : undefined;
  if (!node) return undefined;
  const grid = size * SAMPLES;
  const unit = grid / 24;
  const hit = new Uint8Array(grid * grid);
  const reach = HALF_STROKE * unit;
  for (const points of iconLines(node)) {
    for (let index = 0; index < Math.max(1, points.length - 1); index += 1) {
      const [ax, ay] = points[index]!.map((value) => value * unit) as [number, number];
      const [bx, by] = (points[index + 1] ?? points[index]!).map((value) => value * unit) as [number, number];
      const dx = bx - ax, dy = by - ay;
      const length = dx * dx + dy * dy;
      const left = Math.max(0, Math.floor(Math.min(ax, bx) - reach)), right = Math.min(grid - 1, Math.ceil(Math.max(ax, bx) + reach));
      const top = Math.max(0, Math.floor(Math.min(ay, by) - reach)), bottom = Math.min(grid - 1, Math.ceil(Math.max(ay, by) + reach));
      for (let sy = top; sy <= bottom; sy += 1) {
        for (let sx = left; sx <= right; sx += 1) {
          const px = sx + 0.5 - ax, py = sy + 0.5 - ay;
          const t = length === 0 ? 0 : Math.max(0, Math.min(1, (px * dx + py * dy) / length));
          const ex = px - t * dx, ey = py - t * dy;
          if (ex * ex + ey * ey <= reach * reach) hit[sy * grid + sx] = 1;
        }
      }
    }
  }
  const bitmap = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let count = 0;
      for (let sy = 0; sy < SAMPLES; sy += 1) for (let sx = 0; sx < SAMPLES; sx += 1) count += hit[(y * SAMPLES + sy) * grid + x * SAMPLES + sx]!;
      const alpha = Math.round(255 * count / (SAMPLES * SAMPLES));
      const offset = (y * size + x) * 4;
      bitmap[offset] = Math.round(rgb[2] * alpha / 255);
      bitmap[offset + 1] = Math.round(rgb[1] * alpha / 255);
      bitmap[offset + 2] = Math.round(rgb[0] * alpha / 255);
      bitmap[offset + 3] = alpha;
    }
  }
  return bitmap;
}

const POINTS = 16;

/**
 * A macOS template image of the icon, 16 pt at 1× and 2×: the menu tints it
 * as its text, highlighted and disabled alike. Undefined for an icon it lacks.
 */
export function menuIconImage(images: Pick<typeof NativeImageModule, "createFromBitmap">, name: string): NativeImage | undefined {
  const large = menuIconBitmap(name, POINTS * 2);
  const small = menuIconBitmap(name, POINTS);
  if (!large || !small) return undefined;
  const image = images.createFromBitmap(large, { width: POINTS * 2, height: POINTS * 2, scaleFactor: 2 });
  image.addRepresentation({ scaleFactor: 1, width: POINTS, height: POINTS, buffer: small });
  image.setTemplateImage(true);
  return image;
}
