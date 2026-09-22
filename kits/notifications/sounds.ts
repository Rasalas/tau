import type { SoundName } from "./present.js";

/** Notes as [frequency Hz, start s, length s]: short enough to never talk over anything. */
const NOTES: Record<SoundName, ReadonlyArray<readonly [number, number, number]>> = {
  chime: [[880, 0, 0.16], [1318.5, 0.09, 0.32]],
  ping: [[1567.98, 0, 0.26]],
};

let audio: AudioContext | undefined;

function context(): AudioContext | undefined {
  if (audio) return audio;
  const Audio = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
  audio = Audio ? new Audio() : undefined;
  return audio;
}

/** A page may only start sound after a gesture; call this from one so later sounds play. */
export function unlockSound(): void {
  void context()?.resume().catch(() => undefined);
}

/** Synthesised rather than shipped as files: no asset, no loader, no media policy to widen. */
export function playSound(name: SoundName): boolean {
  const ctx = context();
  if (!ctx) return false;
  if (ctx.state === "suspended") void ctx.resume().catch(() => undefined);
  const start = ctx.currentTime + 0.01;
  for (const [frequency, offset, length] of NOTES[name]) {
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, start + offset);
    gain.gain.exponentialRampToValueAtTime(0.16, start + offset + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + length);
    oscillator.connect(gain).connect(ctx.destination);
    oscillator.start(start + offset);
    oscillator.stop(start + offset + length + 0.02);
  }
  return true;
}
