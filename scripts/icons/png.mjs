// Just enough PNG for the icon generator: read what rsvg-convert writes (8-bit RGBA,
// not interlaced), drop the alpha channel iOS refuses in an app icon, and pack PNGs into an .ico.
import { deflateSync, inflateSync } from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };

const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

function crc32(bytes) {
  let c = -1;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Decodes an 8-bit, non-interlaced PNG into its raw pixels. */
export function decodePng(file) {
  if (!file.subarray(0, 8).equals(SIGNATURE)) throw new Error("not a PNG");
  let offset = 8, header, idat = [];
  while (offset < file.length) {
    const length = file.readUInt32BE(offset);
    const type = file.toString("latin1", offset + 4, offset + 8);
    const data = file.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") header = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), depth: data[8], colour: data[9], interlace: data[12] };
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    offset += 12 + length;
  }
  const channels = CHANNELS[header?.colour];
  if (!header || header.depth !== 8 || header.interlace !== 0 || !channels) throw new Error("unsupported PNG layout");
  const { width, height } = header;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = pixels.subarray(y * stride, (y + 1) * stride);
    const up = y ? pixels.subarray((y - 1) * stride, y * stride) : undefined;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[x - channels] : 0;
      const b = up ? up[x] : 0;
      const c = up && x >= channels ? up[x - channels] : 0;
      const predictor = [0, a, b, (a + b) >> 1, paeth(a, b, c)][filter];
      if (predictor === undefined) throw new Error(`unknown PNG filter ${filter}`);
      out[x] = (line[x] + predictor) & 0xff;
    }
  }
  return { width, height, channels, pixels };
}

/** Encodes raw 8-bit pixels (1–4 channels) as a PNG, each row with the Paeth filter. */
export function encodePng({ width, height, channels, pixels }) {
  const colour = Object.entries(CHANNELS).find(([, count]) => count === channels)?.[0];
  if (colour === undefined) throw new Error(`no PNG colour type with ${channels} channels`);
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 4;
    for (let x = 0; x < stride; x++) {
      const at = y * stride + x;
      const a = x >= channels ? pixels[at - channels] : 0;
      const b = y ? pixels[at - stride] : 0;
      const c = y && x >= channels ? pixels[at - stride - channels] : 0;
      raw[y * (stride + 1) + 1 + x] = (pixels[at] - paeth(a, b, c)) & 0xff;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = Number(colour);
  return Buffer.concat([SIGNATURE, chunk("IHDR", header), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

/** The same image without its alpha channel; the artwork must already be opaque. */
export function withoutAlpha(file) {
  const image = decodePng(file);
  if (image.channels !== 4) return file;
  const pixels = Buffer.alloc(image.width * image.height * 3);
  for (let i = 0, o = 0; i < image.pixels.length; i += 4, o += 3) {
    if (image.pixels[i + 3] !== 255) throw new Error("a pixel is not opaque; flatten the artwork first");
    image.pixels.copy(pixels, o, i, i + 3);
  }
  return encodePng({ ...image, channels: 3, pixels });
}

/** An .ico holding each PNG as it is (Windows Vista and later read PNG entries). */
export function packIco(pngs) {
  const header = Buffer.alloc(6 + 16 * pngs.length);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  let offset = header.length;
  pngs.forEach((png, index) => {
    const { width, height } = decodePng(png);
    const entry = 6 + 16 * index;
    header[entry] = width >= 256 ? 0 : width;
    header[entry + 1] = height >= 256 ? 0 : height;
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(png.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...pngs]);
}
