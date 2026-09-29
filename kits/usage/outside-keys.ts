/**
 * Record keys as 53-bit hashes in typed arrays: a copy of a response in
 * another log (a resumed or archived session) is recognised without a
 * string per response on the heap. Typed arrays live outside the worker's
 * old generation, and millions of keys take a few dozen megabytes.
 */

/** cyrb53: a 53-bit hash of a string, never 0. */
export function keyHash(text: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0) || 1;
}

const EMPTY = 0;
const GONE = -1;

/** A set of key hashes, open addressing over a Float64Array. */
export class KeySet {
  private slots = new Float64Array(1024);
  private used = 0;
  private live = 0;

  get size(): number {
    return this.live;
  }

  /** False when the key was there already. */
  add(key: number): boolean {
    if ((this.used + 1) * 2 > this.slots.length) this.resize(this.live * 4 > this.slots.length ? this.slots.length * 2 : this.slots.length);
    const mask = this.slots.length - 1;
    let free = -1;
    for (let at = key % this.slots.length; ; at = (at + 1) & mask) {
      const value = this.slots[at]!;
      if (value === key) return false;
      if (value === GONE) { if (free < 0) free = at; continue; }
      if (value === EMPTY) {
        if (free < 0) { free = at; this.used += 1; }
        this.slots[free] = key;
        this.live += 1;
        return true;
      }
    }
  }

  has(key: number): boolean {
    const mask = this.slots.length - 1;
    for (let at = key % this.slots.length; ; at = (at + 1) & mask) {
      const value = this.slots[at]!;
      if (value === key) return true;
      if (value === EMPTY) return false;
    }
  }

  delete(key: number): boolean {
    const mask = this.slots.length - 1;
    for (let at = key % this.slots.length; ; at = (at + 1) & mask) {
      const value = this.slots[at]!;
      if (value === key) { this.slots[at] = GONE; this.live -= 1; return true; }
      if (value === EMPTY) return false;
    }
  }

  private resize(size: number): void {
    const old = this.slots;
    this.slots = new Float64Array(size);
    this.used = 0;
    this.live = 0;
    for (const value of old) if (value !== EMPTY && value !== GONE) this.add(value);
  }
}

/** A growing list of key hashes. */
export class KeyList {
  private items: Float64Array;
  length = 0;

  constructor(initial?: Float64Array) {
    this.items = initial ? initial.slice() : new Float64Array(64);
    this.length = initial?.length ?? 0;
  }

  push(key: number): void {
    if (this.length === this.items.length) {
      const grown = new Float64Array(this.items.length * 2);
      grown.set(this.items);
      this.items = grown;
    }
    this.items[this.length++] = key;
  }

  values(): Float64Array {
    return this.items.subarray(0, this.length);
  }
}

export function encodeKeys(keys: Float64Array): string {
  return Buffer.from(keys.buffer, keys.byteOffset, keys.byteLength).toString("base64");
}

export function decodeKeys(text: unknown): Float64Array | undefined {
  if (typeof text !== "string") return undefined;
  const bytes = Buffer.from(text, "base64");
  if (bytes.length % 8 !== 0) return undefined;
  // Copied into an aligned buffer of its own.
  const keys = new Float64Array(bytes.length / 8);
  new Uint8Array(keys.buffer).set(bytes);
  return keys;
}
